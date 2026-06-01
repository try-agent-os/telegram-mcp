import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, readdirSync, unlinkSync, openAsBlob } from 'fs';
import { stat } from 'fs/promises';
import path from 'path';

const execFileP = promisify(execFile);

const MEDIA_DIR = '/tmp/telegram-mcp';

// OpenAI cloud transcription. Replaces local whisper.cpp (nodejs-whisper) since
// 2026-06 — local whisper held ~1.2 GB resident and caused OOM cascades on
// 8 GB hosts. gpt-4o-transcribe is the higher-quality 2025+ successor to
// whisper-1; both share the /v1/audio/transcriptions endpoint and accept
// response_format=text. Override the model via OPENAI_TRANSCRIBE_MODEL
// (e.g. fall back to "whisper-1" if a tenant lacks gpt-4o-transcribe access).
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const OPENAI_API_BASE = (process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1').replace(/\/$/, '');
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-4o-transcribe';
// OpenAI hard cap on /audio/transcriptions uploads.
const OPENAI_MAX_BYTES = 25 * 1024 * 1024;

function ensureMediaDir(): void {
  try {
    mkdirSync(MEDIA_DIR, { recursive: true });
  } catch {
    // exists
  }
}

async function transcribeAudio(filePath: string): Promise<string | null> {
  if (!OPENAI_API_KEY) {
    console.error('[transcribe] OPENAI_API_KEY not set — cannot transcribe');
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
  try {
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
      console.error(`[transcribe] OpenAI ${res.status} (model=${OPENAI_TRANSCRIBE_MODEL}, file=${filename}, ${size}B): ${errBody}`);
      return null;
    }
    const text = (await res.text()).trim();
    // Log length only, never content — voice messages are private.
    console.log(`[transcribe] ok (model=${OPENAI_TRANSCRIBE_MODEL}, file=${filename}, ${size}B → ${text.length} chars)`);
    return text || null;
  } catch (err) {
    console.error('[transcribe] error:', (err as Error).message);
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

const MAX_DURATION_SEC = 600; // 10 min cap — keeps cloud cost predictable and stays under 25 MB.
const MAX_FILESIZE = '24M'; // yt-dlp ceiling, leaves headroom under OpenAI 25 MB cap.

function formatDuration(seconds: number): string {
  if (!seconds) return 'unknown';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m${s.toString().padStart(2, '0')}s` : `${s}s`;
}

export async function processVideo(filePath: string, messageId: number): Promise<string | null> {
  ensureMediaDir();
  // Re-encode to mono 16 kHz MP3 (compact + universally accepted by OpenAI).
  // WAV at 16 kHz would routinely blow past 25 MB for >10-min videos.
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
