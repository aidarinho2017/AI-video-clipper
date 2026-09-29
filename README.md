# Local AI video clipper

Turn a YouTube interview into five ranked, 15–30 second vertical clips. Choose Gemini, Anthropic, or OpenAI for analysis. No accounts, database, or cloud hosting. Captions are not burned into clips.

## Setup

Requires Linux, Python 3.12+, Node.js 22+, and FFmpeg/ffprobe (`sudo apt install ffmpeg`).

From the repository root:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
cp backend/.env.example backend/.env
```

Edit `backend/.env` and add the keys for the providers you want: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, and/or `OPENAI_API_KEY`. Gemini is the default and the transcription fallback when a video has no YouTube captions. Never put keys in the frontend. `MAX_VIDEO_SECONDS` defaults to 7200.

Start the backend from the repository root:

```bash
backend/.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

In a second terminal:

```bash
cd frontend
npm ci
npm run dev
```

After the one-time setup above, both servers can be started with one command from the repository root:

```bash
./start.sh
```

Press `Ctrl+C` to stop both servers.

Open http://localhost:3000. Keep the backend running while a job processes. Use one backend process; do not add `--workers`. Avoid auto-reload during processing.

## How it works

Browser → FastAPI background job → yt-dlp video and timestamped captions → selected AI model → validation/ranking → FFmpeg center crop → five MP4 files. If captions are unavailable, FFmpeg extracts audio and Gemini creates a timestamped transcript first.

The standalone editor imports multiple local videos into a media bin. Add full sources to the timeline, split and trim clips, reframe each clip for a social aspect ratio, position captions directly in the preview, adjust audio, and export one MP4.

The backend requests 15 moments with timestamps, titles, reasoning and scores from the selected model. Every score ranges from 0 (weak/absent) to 100 (exceptional). Candidates must have finite source-relative timestamps and last 15–30 seconds. Ranking uses virality, standalone, hook, then earliest start; the greedy selector rejects overlapping moments. One additional request is allowed if fewer than five survive. The system fails clearly if it cannot select five valid moments.

Virality is an editorial heuristic, not a prediction of views. Audio timestamp estimates can be imperfect, and a center crop can miss off-center speakers. There is no word alignment, face tracking, generated footage, or captions.

## Storage and API

Each job lives in `backend/data/<uuid>/` with its source, extracted audio, candidate JSON, atomic status JSON, and five clips. This directory is ignored by Git. Finished jobs survive restarts; interrupted jobs are marked failed. Only one job runs at a time. Refreshing the browser restores the current job.

- `GET /health`: backend health.
- `GET /ai/models`: configured Gemini, Anthropic, and OpenAI models.
- `POST /jobs`: `{ "youtube_url": "https://www.youtube.com/watch?v=...", "model": "gemini-fast", "instructions": "Prefer practical advice" }`, returns 202 and a job ID; 409 when busy.
- `GET /jobs/{id}`: actual stage, status, completed count, scores and errors.
- `GET /jobs/{id}/clips/{index}`: MP4 preview with range support; `?download=true` downloads it.

Stages reflect completed work, not estimated percentages. Cutting and vertical conversion are one encoding pass. The fallback audio upload is removed from Gemini after transcription where possible; a failed remote cleanup relies on the Files API expiry. Local files remain until you manually remove an individual job directory with the backend stopped. There is no automatic disk cleanup.

Use public videos you have permission to process. YouTube can block automated downloads or require sign-in; this app does not import browser cookies. Keep yt-dlp current if downloads stop working. Node is used by yt-dlp for YouTube's JavaScript challenges. Sources must be at least 75 seconds and within the configured duration limit. The app binds to localhost and is not intended for public exposure.

## Checks

```bash
backend/.venv/bin/python -m unittest discover -s backend/tests -v
backend/.venv/bin/python -m backend.tests.smoke_video
cd frontend
npm run lint
npm run typecheck
npm run build
```

Automated API tests mock YouTube and AI providers. A real end-to-end run requires a valid key for the selected provider, quota, and an accessible YouTube video. Captionless videos also require Gemini. Provider errors appear in the interface; diagnostic details stay in backend logs.
