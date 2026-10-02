# Local AI video clipper

Turn a YouTube interview into 1, 3, 5, or 10 ranked vertical clips. Choose 15–30, 30–60, or 60–90 second clips and use Gemini, Anthropic, or OpenAI for analysis. Generated clips include burned captions and stable face-aware framing. Users sign in with Google and start with 100 credits.

## Setup

Supports Windows 10/11, macOS, and Linux. Install Python 3.12+, Node.js 22+, and an FFmpeg build containing both `ffmpeg` and `ffprobe`. Verify they are on `PATH`:

```text
python --version
node --version
ffmpeg -version
ffprobe -version
```

Common installers:

- macOS with Homebrew: `brew install python@3.12 node ffmpeg`
- Windows with winget: `winget install Python.Python.3.12 OpenJS.NodeJS.LTS Gyan.FFmpeg`
- Ubuntu/Debian: `sudo apt install python3 python3-venv ffmpeg`; install Node.js 22+ if the distribution package is older.

On macOS or Linux, run from the repository root:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
cp backend/.env.example backend/.env
cd frontend && npm ci && cd ..
python3 start.py --check
python3 start.py
```

On Windows PowerShell:

```powershell
py -3.12 -m venv backend/.venv
backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
Copy-Item backend\.env.example backend\.env
Set-Location frontend; npm ci; Set-Location ..
py start.py --check
py start.py
```

Edit `backend/.env` and add the keys for the providers you want: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, and/or `OPENAI_API_KEY`. Gemini is the default and the transcription fallback when a video has no YouTube captions. Never put keys in the frontend. `MAX_VIDEO_SECONDS` defaults to 7200.

Create a Google OAuth 2.0 **Web application** client, add `http://localhost:3000` as an authorized JavaScript origin, then set `GOOGLE_CLIENT_ID` to its client ID. Set `AUTH_SECRET` to a random value of at least 32 characters. For HTTPS deployment, also set `AUTH_COOKIE_SECURE=true`.

User accounts and balances are stored in `backend/data/users.sqlite3`. A new Google account receives 100 credits; creating a job costs one credit per requested clip (1, 3, 5, or 10). Credits are charged when the job is accepted.

The Python launcher starts both servers and shuts down both process trees on `Ctrl+C`. If your Python command has a different name, use the same command that created `backend/.venv`.

Open http://localhost:3000. Keep the backend running while a job processes. Use one backend process; do not add `--workers`. Avoid auto-reload during processing.

## How it works

Browser → FastAPI background job → yt-dlp video and timestamped captions → selected AI model → validation/ranking → face-aware crop and captioned FFmpeg render → MP4 files. If captions are unavailable, FFmpeg extracts audio and Gemini creates a timestamped transcript first.

The standalone editor imports multiple local videos and audio files. Add sources to the timeline, split and trim clips, mix waveform-backed audio tracks with per-clip volume and fades, add crossfades, reframe for social aspect ratios, position captions directly in the preview, and export one MP4.

The backend requests at least 15 moments with timestamps, titles, reasoning and scores from the selected model, scaling the candidate pool for larger batches. Every score ranges from 0 (weak/absent) to 100 (exceptional). Candidates must have finite source-relative timestamps and match the selected length range. Ranking uses virality, standalone, hook, then earliest start; the greedy selector rejects overlapping moments. One additional request is allowed when the requested count is not met. If at least one moment survives, the job returns the best available clips and reports the actual count.

Virality is an editorial heuristic, not a prediction of views. Audio timestamp estimates can be imperfect, and a center crop can miss off-center speakers. There is no word alignment, face tracking, generated footage, or captions.

## Storage and API

Each job lives in `backend/data/<uuid>/` with its source, extracted audio, candidate JSON, atomic status JSON, and generated clips. This directory is ignored by Git. Finished jobs survive restarts; interrupted jobs are marked failed. Only one job runs at a time. Refreshing the browser restores the current job.

- `GET /health`: backend health.
- `GET /ai/models`: configured Gemini, Anthropic, and OpenAI models.
- `POST /jobs`: `{ "youtube_url": "https://www.youtube.com/watch?v=...", "model": "gemini-fast", "instructions": "Prefer practical advice", "clip_length": "short", "clip_count": 5 }`, returns 202 and a job ID; 409 when busy. Length is `short`, `medium`, or `long`; count is 1, 3, 5, or 10.
- `GET /jobs/{id}`: actual stage, status, completed count, scores and errors.
- `GET /jobs/{id}/clips/{index}`: MP4 preview with range support; `?download=true` downloads it.

Stages reflect completed work, not estimated percentages. Cutting and vertical conversion are one encoding pass. The fallback audio upload is removed from Gemini after transcription where possible; a failed remote cleanup relies on the Files API expiry. Local files remain until you manually remove an individual job directory with the backend stopped. There is no automatic disk cleanup.

Use public videos you have permission to process. YouTube can block automated downloads or require sign-in; this app does not import browser cookies. Keep yt-dlp current if downloads stop working. Node is used by yt-dlp for YouTube's JavaScript challenges. Sources must be at least 75 seconds and within the configured duration limit. The app binds to localhost and is not intended for public exposure.

## Checks

macOS/Linux:

```bash
backend/.venv/bin/python -m unittest discover -s backend/tests -v
backend/.venv/bin/python -m backend.tests.smoke_video
cd frontend && npm test && npm run lint && npm run typecheck && npm run build
```

Windows PowerShell:

```powershell
backend\.venv\Scripts\python.exe -m unittest discover -s backend/tests -v
backend\.venv\Scripts\python.exe -m backend.tests.smoke_video
Set-Location frontend; npm test; npm run lint; npm run typecheck; npm run build
```

Automated API tests mock YouTube and AI providers. A real end-to-end run requires a valid key for the selected provider, quota, and an accessible YouTube video. Captionless videos also require Gemini. Provider errors appear in the interface; diagnostic details stay in backend logs.
