import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, readdirSync, unlinkSync, openAsBlob } from 'fs';
import { stat, readFile } from 'fs/promises';
import path from 'path';
import { nodewhisper } from 'nodejs-whisper';

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Transcription backends (runtime-selectable)
// ---------------------------------------------------------------------------
// Three interchangeable backends share the same (filePath) -> text|null shape:
//   1. openai         — OpenAI cloud Whisper API (gpt-4o-transcribe). Fastest,
//                       no local model RAM, but sends audio off-device.
//   2. whisper-server — local long-running whisper-server over HTTP (model stays
//                       resident in RAM, saves the per-call model-load latency).
//   3. whisper-cli    — local whisper.cpp spawned per call via nodejs-whisper.
//                       Fully on-device, no resident process; slowest cold path.
//
// Selection is purely token-driven (no separate selector var):
//   • OPENAI_API_KEY set (non-empty)  → openai cloud.
//   • OPENAI_API_KEY absent           → local: WHISPER_SERVER_URL set ?
//                                        whisper-server : whisper-cli.
//   Presence of the OpenAI token = opt into cloud (speed); absence = stay
//   on-device (privacy), preferring a resident whisper-server when configured.
//
// Env vars:
//   OPENAI_API_KEY          present → cloud backend; absent → local backend
//   OPENAI_API_BASE         default https://api.openai.com/v1
//   OPENAI_TRANSCRIBE_MODEL default gpt-4o-transcribe (e.g. "whisper-1" fallback)
//   WHISPER_SERVER_URL      base URL of a running whisper-server (local server backend)
//   WHISPER_MODEL           local model name for whisper-cli (default "medium")
//   TELEGRAM_MCP_MEDIA_DIR  scratch dir for extracted audio (default /tmp/telegram-mcp)
// ---------------------------------------------------------------------------

const MEDIA_DIR = process.env.TELEGRAM_MCP_MEDIA_DIR ?? '/tmp/telegram-mcp';
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? 'medium';
const WHISPER_SERVER_URL = process.env.WHISPER_SERVER_URL ?? '';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const OPENAI_API_BASE = (process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1').replace(/\/$/, '');
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-4o-transcribe';
// OpenAI hard cap on /audio/transcriptions uploads.
const OPENAI_MAX_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Frame vision analysis (raskadrovka)
// ---------------------------------------------------------------------------
// For forwarded reels/short videos we additionally extract a handful of key
// frames and describe each one with a vision model, so the operator can see
// *what* is shown on screen (UI, dashboards, on-screen text), not only the
// transcribed words. Best-effort: any failure degrades gracefully to
// transcription-only — the frame pass never throws up to the caller.
//
// Backend is token-driven, mirroring the transcription selector:
//   • ANTHROPIC_API_KEY set → Anthropic Messages API (VISION_MODEL, default a
//                             current Claude vision model).
//   • else OPENAI_API_KEY set → OpenAI chat/completions vision (OPENAI_VISION_MODEL).
//   • neither → frames disabled (returns null).
//
// Env vars:
//   MEDIA_FRAMES_DISABLED   set to "1"/"true" → skip frame analysis entirely
//   MEDIA_FRAME_COUNT       override auto frame count (default: clamp(dur/10, 3, 8))
//   ANTHROPIC_API_KEY       present → anthropic vision backend
//   ANTHROPIC_API_BASE      default https://api.anthropic.com
//   VISION_MODEL            anthropic vision model (default claude-opus-4-8)
//   OPENAI_VISION_MODEL     openai vision model (default gpt-4o)
// ---------------------------------------------------------------------------

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const ANTHROPIC_API_BASE = (process.env.ANTHROPIC_API_BASE ?? 'https://api.anthropic.com').replace(/\/$/, '');
const VISION_MODEL = process.env.VISION_MODEL ?? 'claude-opus-4-8';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL ?? 'gpt-4o';
const FRAMES_DISABLED = /^(1|true|yes)$/i.test(process.env.MEDIA_FRAMES_DISABLED ?? '');
const FRAME_COUNT_OVERRIDE = parseInt(process.env.MEDIA_FRAME_COUNT ?? '', 10);
// Vision downloads a full-resolution video; cap it well below yt-dlp's audio ceiling.
const MAX_VIDEO_FILESIZE = process.env.MEDIA_MAX_VIDEO_FILESIZE ?? '60M';
// Frame description prompt — Russian, since the operator reads Russian.
const FRAME_PROMPT =
  'Опиши кратко, одним-двумя предложениями (максимум 200 символов), что показано на этом кадре из видео: ' +
  'текст на экране, UI/дашборд, объекты, действие. Без вступлений и кавычек — только описание.';

type VisionBackend = 'anthropic' | 'openai' | null;

function resolveVisionBackend(): VisionBackend {
  if (FRAMES_DISABLED) return null;
  if (ANTHROPIC_API_KEY) return 'anthropic';
  if (OPENAI_API_KEY) return 'openai';
  return null;
}

type TranscriptionBackend = 'openai' | 'whisper-server' | 'whisper-cli';

// Token-driven: OPENAI_API_KEY present → cloud; absent → local
// (whisper-server if WHISPER_SERVER_URL set, else whisper-cli).
function resolveBackend(): TranscriptionBackend {
  if (OPENAI_API_KEY) return 'openai';
  return WHISPER_SERVER_URL ? 'whisper-server' : 'whisper-cli';
}

function ensureMediaDir(): void {
  try {
    mkdirSync(MEDIA_DIR, { recursive: true });
  } catch {
    // exists
  }
}

function parseWhisperOutput(raw: string): string {
  // whisper-cli prints lines like "[00:00:00.000 --> 00:00:05.600]   text"
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const segments = lines
    .map(l => l.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, ''))
    .filter(Boolean);
  return segments.join(' ').trim();
}

// --- Backend 1: OpenAI cloud (gpt-4o-transcribe) ---------------------------
async function transcribeViaOpenAI(filePath: string): Promise<string | null> {
  if (!OPENAI_API_KEY) {
    console.error('[transcribe] OPENAI_API_KEY not set — cannot transcribe via openai');
    return null;
  }
  const filename = path.basename(filePath);
  let size = 0;
  try {
    const stats = await stat(filePath);
    size = stats.size;
  } catch (err) {
    console.error('[transcribe] stat failed:', (err as Error).message);
    return null;
  }
  if (size > OPENAI_MAX_BYTES) {
    console.error(`[transcribe] file too large: ${size}B > ${OPENAI_MAX_BYTES}B (${filename})`);
    return null;
  }
  if (size === 0) {
    console.error(`[transcribe] empty file (${filename})`);
    return null;
  }
  // openAsBlob (Node >=19.8) streams instead of buffering the whole audio.
  const blob = await openAsBlob(filePath);
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('model', OPENAI_TRANSCRIBE_MODEL);
  form.append('response_format', 'text');
  // temperature=0 for deterministic output (gpt-4o-transcribe + whisper-1 both honor it).
  form.append('temperature', '0');
  const res = await fetch(`${OPENAI_API_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const errBody = (await res.text()).slice(0, 200);
    throw new Error(`OpenAI ${res.status} (model=${OPENAI_TRANSCRIBE_MODEL}, file=${filename}, ${size}B): ${errBody}`);
  }
  const text = (await res.text()).trim();
  // Log length only, never content — voice messages are private.
  console.log(`[transcribe] openai ok (model=${OPENAI_TRANSCRIBE_MODEL}, file=${filename}, ${size}B → ${text.length} chars)`);
  return text || null;
}

// --- Backend 2: local whisper-server over HTTP -----------------------------
async function transcribeViaServer(filePath: string): Promise<string | null> {
  const url = `${WHISPER_SERVER_URL.replace(/\/$/, '')}/inference`;
  const filename = path.basename(filePath);
  const stats = await stat(filePath);
  // whisper-server expects multipart/form-data with field name "file".
  // `language=auto` mirrors the CLI default; temperature=0 makes it deterministic.
  // openAsBlob (Node >=19.8) avoids buffering the whole audio into JS heap.
  const blob = await openAsBlob(filePath);
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('language', 'auto');
  form.append('response_format', 'text');
  form.append('temperature', '0');
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error(`whisper-server ${res.status}: ${await res.text()} (file ${filename}, ${stats.size}B)`);
  }
  const text = (await res.text()).trim();
  return text || null;
}

// --- Backend 3: local whisper-cli per call (nodejs-whisper) ----------------
async function transcribeViaCli(filePath: string): Promise<string | null> {
  const raw = await nodewhisper(filePath, {
    modelName: WHISPER_MODEL,
    whisperOptions: {
      outputInText: false,
      outputInSrt: false,
      outputInVtt: false,
      outputInJson: false,
      translateToEnglish: false,
      wordTimestamps: false,
    },
  });
  return parseWhisperOutput(raw) || null;
}

async function transcribeAudio(filePath: string): Promise<string | null> {
  const backend = resolveBackend();
  try {
    switch (backend) {
      case 'openai':
        return await transcribeViaOpenAI(filePath);
      case 'whisper-server':
        return await transcribeViaServer(filePath);
      case 'whisper-cli':
      default:
        return await transcribeViaCli(filePath);
    }
  } catch (err) {
    console.error(`[transcribe] ${backend} error:`, (err as Error).message);
    return null;
  }
}

export async function transcribeVoice(filePath: string): Promise<string | null> {
  return transcribeAudio(filePath);
}

// URL patterns for platforms where transcription adds value.
// yt-dlp supports ~1900 sites but we gate on this list to avoid network probes for random links.
const URL_PATTERNS: RegExp[] = [
  /https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)[\w-]+[\w\-?=&#%.]*/i,
  /https?:\/\/youtu\.be\/[\w-]+[\w\-?=&#%.]*/i,
  /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p|tv|reels)\/[\w-]+[\w\-?=&#%.\/]*/i,
  /https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/(?:@[\w.-]+\/video\/\d+|[\w-]+)[\w\-?=&#%.\/]*/i,
  /https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/[\w-]+\/status\/\d+[\w\-?=&#%.\/]*/i,
  /https?:\/\/(?:www\.)?vimeo\.com\/\d+[\w\-?=&#%.\/]*/i,
  /https?:\/\/(?:www\.)?facebook\.com\/(?:watch\/?\?v=|[\w.-]+\/videos\/)\d+[\w\-?=&#%.\/]*/i,
  /https?:\/\/(?:v\.redd\.it|(?:www\.)?reddit\.com\/r\/[\w-]+\/comments\/\w+)[\w\-?=&#%.\/]*/i,
];

export function extractMediaUrl(text: string): string | null {
  for (const re of URL_PATTERNS) {
    const match = text.match(re);
    if (match) return match[0];
  }
  return null;
}

interface UrlMetadata {
  title: string;
  uploader: string;
  duration: number; // seconds
}

async function fetchMetadata(url: string): Promise<UrlMetadata | null> {
  try {
    const { stdout } = await execFileP('yt-dlp', [
      '--quiet',
      '--no-warnings',
      '--skip-download',
      '--print', '%(title)s\n%(uploader,channel,uploader_id)s\n%(duration)s',
      url,
    ], { timeout: 30000 });
    const [title = '', uploader = '', durationStr = '0'] = stdout.trim().split('\n');
    const duration = parseInt(durationStr, 10) || 0;
    return { title, uploader, duration };
  } catch (err) {
    console.error('[yt-dlp] metadata error:', (err as Error).message);
    return null;
  }
}

function cleanupTempAudio(prefix: string): void {
  try {
    const files = readdirSync(MEDIA_DIR);
    for (const f of files) {
      if (f.startsWith(prefix)) {
        try { unlinkSync(path.join(MEDIA_DIR, f)); } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore
  }
}

const MAX_DURATION_SEC = 600; // 10 min cap — keeps cloud cost predictable and local whisper within ~1.3x realtime.
const MAX_FILESIZE = '24M'; // yt-dlp ceiling, leaves headroom under the OpenAI 25 MB cap.

function formatDuration(seconds: number): string {
  if (!seconds) return 'unknown';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m${s.toString().padStart(2, '0')}s` : `${s}s`;
}

function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`;
}

// ffprobe a media file's duration in seconds (0 if unknown).
async function probeDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { timeout: 20000 });
    return Math.floor(parseFloat(stdout.trim()) || 0);
  } catch {
    return 0;
  }
}

// How many frames to grab: ~1 per 10s, clamped to the [3, 8] band the task asks for.
function frameCountFor(durationSec: number): number {
  if (Number.isFinite(FRAME_COUNT_OVERRIDE) && FRAME_COUNT_OVERRIDE > 0) {
    return Math.min(8, Math.max(1, FRAME_COUNT_OVERRIDE));
  }
  if (!durationSec) return 4;
  return Math.min(8, Math.max(3, Math.round(durationSec / 10)));
}

// Extract N evenly-spaced frames (downscaled to <=768px wide JPEGs). Fast seek
// (-ss before -i) keeps each grab cheap. Returns [{ts, path}] for the frames
// that were actually written.
async function extractFrames(
  videoPath: string,
  prefix: string,
  durationSec: number,
): Promise<Array<{ ts: number; path: string }>> {
  const count = frameCountFor(durationSec);
  // When duration is unknown, sample the first ~30s uniformly as a best effort.
  const span = durationSec > 0 ? durationSec : 30;
  const frames: Array<{ ts: number; path: string }> = [];
  const jobs: Array<Promise<void>> = [];
  for (let i = 0; i < count; i++) {
    const ts = (span * (i + 0.5)) / count;
    const outPath = path.join(MEDIA_DIR, `${prefix}_frame_${i}.jpg`);
    jobs.push(
      execFileP('ffmpeg', [
        '-y',
        '-ss', ts.toFixed(2),
        '-i', videoPath,
        '-frames:v', '1',
        '-vf', "scale='min(768,iw)':-2",
        '-q:v', '3',
        outPath,
      ], { timeout: 30000 })
        .then(async () => {
          try {
            const st = await stat(outPath);
            if (st.size > 0) frames.push({ ts, path: outPath });
          } catch { /* frame not produced */ }
        })
        .catch(() => { /* seek past EOF or decode error — skip this frame */ }),
    );
  }
  await Promise.all(jobs);
  frames.sort((a, b) => a.ts - b.ts);
  return frames;
}

// --- Vision backend: OpenAI chat/completions (gpt-4o) ----------------------
async function describeFrameViaOpenAI(b64: string): Promise<string | null> {
  const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_VISION_MODEL,
      max_tokens: 150,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: FRAME_PROMPT },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'low' } },
        ],
      }],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI vision ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() || null;
}

// --- Vision backend: Anthropic Messages API --------------------------------
async function describeFrameViaAnthropic(b64: string): Promise<string | null> {
  const res = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: FRAME_PROMPT },
        ],
      }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic vision ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join(' ').trim();
  return text || null;
}

async function describeFrame(framePath: string, backend: Exclude<VisionBackend, null>): Promise<string | null> {
  try {
    const b64 = (await readFile(framePath)).toString('base64');
    const raw = backend === 'anthropic'
      ? await describeFrameViaAnthropic(b64)
      : await describeFrameViaOpenAI(b64);
    if (!raw) return null;
    // Enforce the ≤200-char criterion; collapse whitespace/newlines.
    const clean = raw.replace(/\s+/g, ' ').trim();
    return clean.length > 200 ? `${clean.slice(0, 197)}...` : clean;
  } catch (err) {
    console.error('[frames] vision error:', (err as Error).message);
    return null;
  }
}

// Orchestrate: extract frames from a local video, describe each in parallel,
// return a formatted `[Frames]:` section (or null if nothing usable / disabled).
async function analyzeFrames(videoPath: string, prefix: string, durationSec: number): Promise<string | null> {
  const backend = resolveVisionBackend();
  if (!backend) return null;
  try {
    const frames = await extractFrames(videoPath, prefix, durationSec);
    if (frames.length === 0) return null;
    const descriptions = await Promise.all(frames.map(f => describeFrame(f.path, backend)));
    // Clean up frame JPEGs.
    for (const f of frames) { try { unlinkSync(f.path); } catch { /* ignore */ } }
    const lines = frames
      .map((f, i) => ({ ts: f.ts, desc: descriptions[i] }))
      .filter(x => x.desc)
      .map(x => `${formatTimestamp(x.ts)} — ${x.desc}`);
    if (lines.length === 0) return null;
    console.log(`[frames] ${backend}: ${lines.length}/${frames.length} frames described (${prefix})`);
    return `[Frames]:\n${lines.join('\n')}`;
  } catch (err) {
    console.error('[frames] analyze error:', (err as Error).message);
    return null;
  }
}

export async function processVideo(filePath: string, messageId: number): Promise<string | null> {
  ensureMediaDir();
  // Re-encode to mono 16 kHz MP3 (compact + universally accepted by OpenAI and whisper.cpp).
  // WAV at 16 kHz would routinely blow past 25 MB for >10-min videos on the cloud backend.
  const audioPath = path.join(MEDIA_DIR, `vid_${messageId}.mp3`);
  try {
    const duration = await probeDuration(filePath);
    // Audio extraction is isolated so a silent / audio-less video still gets frames.
    const transcribePromise = execFileP('ffmpeg', [
      '-y',
      '-i', filePath,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-b:a', '32k',
      '-f', 'mp3',
      audioPath,
    ], { timeout: 120000 })
      .then(() => transcribeAudio(audioPath))
      .catch((err: Error) => {
        console.error('[video] audio extraction error:', err.message);
        return null;
      });

    const [text, frames] = await Promise.all([
      transcribePromise,
      analyzeFrames(filePath, `vid_${messageId}`, duration),
    ]);
    if (!text && !frames) return null;
    const parts: string[] = [];
    if (text) parts.push(`[video transcription] ${text}`);
    if (frames) parts.push(frames);
    return parts.join('\n\n');
  } catch (err) {
    console.error('[video] extraction error:', (err as Error).message);
    return null;
  } finally {
    try { unlinkSync(audioPath); } catch { /* ignore */ }
  }
}

// Audio-only path (original behaviour): yt-dlp extracts mp3, then transcribe.
// Used as the fallback when frame vision is off, or when the video download failed.
async function downloadAndTranscribeAudio(url: string, prefix: string): Promise<string | null> {
  const outputTemplate = path.join(MEDIA_DIR, `${prefix}.%(ext)s`);
  await execFileP('yt-dlp', [
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '5', // good enough for speech, smaller file
    '--max-filesize', MAX_FILESIZE,
    '--no-playlist',
    '--no-warnings',
    '-o', outputTemplate,
    url,
  ], { timeout: 180000 });

  const audioFile = readdirSync(MEDIA_DIR)
    .filter(f => f.startsWith(`${prefix}.`))
    .find(f => f.endsWith('.mp3'));
  if (!audioFile) return null;
  return transcribeAudio(path.join(MEDIA_DIR, audioFile));
}

// Download the video itself (capped) so we can derive both audio and key frames
// from a single fetch. Returns the local video path, or null on failure.
async function downloadVideo(url: string, prefix: string): Promise<string | null> {
  const outputTemplate = path.join(MEDIA_DIR, `${prefix}_v.%(ext)s`);
  try {
    await execFileP('yt-dlp', [
      '-f', 'best*[height<=720]/best',
      '--max-filesize', MAX_VIDEO_FILESIZE,
      '--no-playlist',
      '--no-warnings',
      '--merge-output-format', 'mp4',
      '-o', outputTemplate,
      url,
    ], { timeout: 180000 });
    const vid = readdirSync(MEDIA_DIR)
      .filter(f => f.startsWith(`${prefix}_v.`))
      .find(f => /\.(mp4|mkv|webm|mov)$/i.test(f));
    return vid ? path.join(MEDIA_DIR, vid) : null;
  } catch (err) {
    console.error('[yt-dlp] video download error:', (err as Error).message);
    return null;
  }
}

export async function processUrl(url: string, messageId: number): Promise<string | null> {
  ensureMediaDir();

  const metadata = await fetchMetadata(url);
  if (!metadata) return null;

  const header = `[Media: ${metadata.title} — ${metadata.uploader} (${formatDuration(metadata.duration)})]`;

  if (metadata.duration > MAX_DURATION_SEC) {
    return `${header}\n[transcription skipped: duration > ${MAX_DURATION_SEC / 60} min]`;
  }

  const cleanupPrefix = `url_${messageId}`;
  const wantFrames = resolveVisionBackend() !== null;

  try {
    let text: string | null = null;
    let frames: string | null = null;
    let gotVideo = false;

    if (wantFrames) {
      // One fetch → both transcription (via local ffmpeg audio extract) and frames.
      const videoPath = await downloadVideo(url, cleanupPrefix);
      if (videoPath) {
        gotVideo = true;
        const audioPath = path.join(MEDIA_DIR, `${cleanupPrefix}.mp3`);
        try {
          await execFileP('ffmpeg', [
            '-y', '-i', videoPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '32k', '-f', 'mp3', audioPath,
          ], { timeout: 120000 });
          [text, frames] = await Promise.all([
            transcribeAudio(audioPath),
            analyzeFrames(videoPath, cleanupPrefix, metadata.duration),
          ]);
        } finally {
          try { unlinkSync(audioPath); } catch { /* ignore */ }
        }
      }
    }

    // Fallback to the audio-only path when frames are off or the video fetch failed.
    if (!gotVideo) {
      text = await downloadAndTranscribeAudio(url, cleanupPrefix);
    }

    if (!text && !frames) {
      return `${header}\n[transcription failed]`;
    }

    const parts: string[] = [header];
    if (text) parts.push(`[Transcription]:\n${text}`);
    if (frames) parts.push(frames);
    return parts.join('\n\n');
  } catch (err) {
    console.error('[yt-dlp] download/transcribe error:', (err as Error).message);
    return `${header}\n[transcription failed: ${(err as Error).message}]`;
  } finally {
    cleanupTempAudio(cleanupPrefix);
  }
}
