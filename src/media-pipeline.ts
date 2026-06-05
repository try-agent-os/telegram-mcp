import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, readdirSync, unlinkSync, openAsBlob } from 'fs';
import { stat } from 'fs/promises';
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
// Selection (TRANSCRIPTION_BACKEND = openai | whisper-server | whisper-cli):
//   • Explicit value wins (openai requires OPENAI_API_KEY; if missing we warn
//     and fall through to the auto chain rather than silently failing).
//   • Unset → backward-compatible auto-detect:
//       WHISPER_SERVER_URL set → whisper-server, else → whisper-cli.
//     (Cloud is never auto-selected without an explicit opt-in, to keep audio
//      on-device by default.)
//
// Env vars:
//   TRANSCRIPTION_BACKEND   openai | whisper-server | whisper-cli (optional)
//   OPENAI_API_KEY          required for the openai backend
//   OPENAI_API_BASE         default https://api.openai.com/v1
//   OPENAI_TRANSCRIBE_MODEL default gpt-4o-transcribe (e.g. "whisper-1" fallback)
//   WHISPER_SERVER_URL      base URL of a running whisper-server (server backend)
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

type TranscriptionBackend = 'openai' | 'whisper-server' | 'whisper-cli';

function resolveBackend(): TranscriptionBackend {
  const explicit = (process.env.TRANSCRIPTION_BACKEND ?? '').trim().toLowerCase();
  if (explicit === 'openai') {
    if (OPENAI_API_KEY) return 'openai';
    console.error('[transcribe] TRANSCRIPTION_BACKEND=openai but OPENAI_API_KEY not set — falling back to local whisper');
  } else if (explicit === 'whisper-server') {
    return 'whisper-server';
  } else if (explicit === 'whisper-cli') {
    return 'whisper-cli';
  } else if (explicit) {
    console.error(`[transcribe] unknown TRANSCRIPTION_BACKEND="${explicit}" — falling back to auto-detect`);
  }
  // Auto-detect: never picks cloud implicitly (keeps audio on-device by default).
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

export async function processVideo(filePath: string, messageId: number): Promise<string | null> {
  ensureMediaDir();
  // Re-encode to mono 16 kHz MP3 (compact + universally accepted by OpenAI and whisper.cpp).
  // WAV at 16 kHz would routinely blow past 25 MB for >10-min videos on the cloud backend.
  const audioPath = path.join(MEDIA_DIR, `vid_${messageId}.mp3`);
  try {
    await execFileP('ffmpeg', [
      '-y',
      '-i', filePath,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-b:a', '32k',
      '-f', 'mp3',
      audioPath,
    ], { timeout: 120000 });

    const text = await transcribeAudio(audioPath);
    return text ? `[video transcription] ${text}` : null;
  } catch (err) {
    console.error('[video] extraction error:', (err as Error).message);
    return null;
  } finally {
    try { unlinkSync(audioPath); } catch { /* ignore */ }
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

  const outputTemplate = path.join(MEDIA_DIR, `url_${messageId}.%(ext)s`);
  const cleanupPrefix = `url_${messageId}`;

  try {
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

    // find downloaded file
    const files = readdirSync(MEDIA_DIR).filter(f => f.startsWith(cleanupPrefix));
    const audioFile = files.find(f => f.endsWith('.mp3'));
    if (!audioFile) {
      return `${header}\n[transcription failed: audio download produced no file]`;
    }

    const audioPath = path.join(MEDIA_DIR, audioFile);
    const text = await transcribeAudio(audioPath);

    if (!text) {
      return `${header}\n[transcription failed]`;
    }

    return `${header}\n\n[Transcription]:\n${text}`;
  } catch (err) {
    console.error('[yt-dlp] download/transcribe error:', (err as Error).message);
    return `${header}\n[transcription failed: ${(err as Error).message}]`;
  } finally {
    cleanupTempAudio(cleanupPrefix);
  }
}
