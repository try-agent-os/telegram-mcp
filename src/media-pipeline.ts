import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, readdirSync, unlinkSync, openAsBlob } from 'fs';
import { stat } from 'fs/promises';
import path from 'path';
import { nodewhisper } from 'nodejs-whisper';

const execFileP = promisify(execFile);

const MEDIA_DIR = process.env.TELEGRAM_MCP_MEDIA_DIR ?? '/tmp/telegram-mcp';
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? 'medium';
// When set, transcription is routed via HTTP to a long-running whisper-server
// (model resident in RAM — saves the ~1-3s model-load on every call). When unset,
// falls back to spawning whisper-cli per call via nodejs-whisper.
const WHISPER_SERVER_URL = process.env.WHISPER_SERVER_URL ?? '';

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
  try {
    return WHISPER_SERVER_URL
      ? await transcribeViaServer(filePath)
      : await transcribeViaCli(filePath);
  } catch (err) {
    console.error('[whisper] transcription error:', (err as Error).message);
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

const MAX_DURATION_SEC = 600; // 10 min cap — medium whisper ~ 1.3x realtime
const MAX_FILESIZE = '50M';

function formatDuration(seconds: number): string {
  if (!seconds) return 'unknown';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m${s.toString().padStart(2, '0')}s` : `${s}s`;
}

export async function processVideo(filePath: string, messageId: number): Promise<string | null> {
  ensureMediaDir();
  const audioPath = path.join(MEDIA_DIR, `vid_${messageId}.wav`);
  try {
    await execFileP('ffmpeg', [
      '-y',
      '-i', filePath,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
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
