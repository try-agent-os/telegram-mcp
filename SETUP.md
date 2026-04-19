# Setup

## Prerequisites

- Node.js 20+
- `cmake` — needed to build whisper.cpp for local voice transcription
  - macOS: `brew install cmake`
  - Debian/Ubuntu: `sudo apt install cmake build-essential`
- `ffmpeg` — used by whisper.cpp to convert OGG Opus voice messages to WAV, and for extracting audio from videos
  - macOS: `brew install ffmpeg`
  - Debian/Ubuntu: `sudo apt install ffmpeg`
- `yt-dlp` — downloads audio from URLs (YouTube, Instagram, TikTok, etc.) for transcription
  - macOS: `brew install yt-dlp`
  - Debian/Ubuntu: `sudo apt install yt-dlp` (or `pip install yt-dlp`)
- `pdftotext` (from poppler) — extracts text from PDF documents
  - macOS: `brew install poppler`
  - Debian/Ubuntu: `sudo apt install poppler-utils`
- `tesseract` + language packs — OCR for photos with text (Russian + English by default)
  - macOS: `brew install tesseract tesseract-lang`
  - Debian/Ubuntu: `sudo apt install tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng`

## Install

```bash
npm install
```

## Download Whisper model

Voice messages are transcribed locally via `nodejs-whisper` (whisper.cpp).
The `medium` model (~1.5GB) is required — good Russian accuracy, ~1.3x realtime on Apple Silicon with Metal.

```bash
cd node_modules/nodejs-whisper/cpp/whisper.cpp/models
bash download-ggml-model.sh medium
```

The model file will be placed at:
`node_modules/nodejs-whisper/cpp/whisper.cpp/models/ggml-medium.bin`

## Build whisper.cpp

whisper.cpp is built automatically on the first transcription call. To pre-build (recommended for the first deployment so the first voice message doesn't time out):

```bash
cd node_modules/nodejs-whisper/cpp/whisper.cpp
cmake -B build
cmake --build build -j --config Release
```

On Apple Silicon this builds with Metal (GPU) + BLAS (Accelerate framework) automatically.

## Environment

Create `.env`:

```
TELEGRAM_BOT_TOKEN=<your bot token>
PORT=3848
```

## Run

```bash
npm run build
npm start
```

Or for dev:

```bash
npm run dev
```

## Verify voice transcription

Send a voice message to the bot. On first call, whisper.cpp builds (takes ~30s) and Metal shaders compile. Subsequent calls: ~1.3x realtime.

Logs should show:
```
[Nodejs-whisper] Converting file to WAV format: /tmp/telegram-mcp/voice_X.ogg
whisper_full_with_state: auto-detected language: ru (p = 0.97)
[Nodejs-whisper] Transcribing Done!
```

## Redeploy notes

- `node_modules/nodejs-whisper/cpp/whisper.cpp/build/` and `models/ggml-medium.bin` are **not** in git — they must be rebuilt / redownloaded on each fresh `npm install`.
- If you update `nodejs-whisper`, re-run the model download and build steps.

## Run as a launchd user agent (macOS)

Example plist in `deploy/com.novostudio.telegram-mcp.plist`. Copy it to `~/Library/LaunchAgents/`, adjust paths, then bootstrap:

```bash
cp deploy/com.novostudio.telegram-mcp.plist ~/Library/LaunchAgents/
# edit paths inside the plist (node binary, project dir, log file)
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.novostudio.telegram-mcp.plist
```

Restart after a code change (`npm run build` first — the plist runs `dist/index.js`):

```bash
launchctl kickstart -k "gui/$(id -u)/com.novostudio.telegram-mcp"
```

Logs go to the path set in `StandardOutPath` / `StandardErrorPath` (e.g. `~/Library/Logs/telegram-mcp.log`).

**Important**: the plist sets an explicit `PATH` that includes `/opt/homebrew/bin` so `ffmpeg` (needed by whisper.cpp to convert OGG → WAV) is found. launchd does not inherit your shell's PATH.

## Local install log (macOS / Apple Silicon, 2026-04-19)

Exact commands that worked on the dev machine. Reproduce or adapt for a new setup:

```bash
# 1. Install the package
npm install nodejs-whisper

# 2. Install cmake (was missing — npx nodejs-whisper download is interactive and doesn't work in non-TTY)
brew install cmake
# ffmpeg was already installed via brew

# 3. Download medium model directly (bypass the interactive wizard)
cd node_modules/nodejs-whisper/cpp/whisper.cpp/models
bash download-ggml-model.sh medium
# ~1.5GB, ~36s on a decent connection
cd -

# 4. Pre-build whisper.cpp (otherwise it builds on first nodewhisper() call)
cd node_modules/nodejs-whisper/cpp/whisper.cpp
cmake -B build          # detects Metal + BLAS/Accelerate automatically
cmake --build build -j --config Release
# produces build/bin/whisper-cli
cd -
```

Verified end-to-end:
- Russian TTS sample (`say -v Milena` → OGG Opus via ffmpeg) transcribed correctly.
- Auto-detected language `ru` with `p=0.977`.
- Warm transcription: ~1.3x realtime (5.7s audio → ~7-8s).
- Cold first run: ~35s (model load + Metal shader compile).

Gotchas encountered:
- `npx nodejs-whisper download` uses `readline-sync` → fails in non-TTY environments. Use the bash script in `models/` directly.
- Without `cmake` installed, the first `nodewhisper()` call fails with `whisper-cli executable not found`.
