# Local AI video clipper

Turn a YouTube interview into 1, 3, 5, or 10 ranked vertical clips. Choose 15–30, 30–60, or 60–90 second clips and use Gemini, Anthropic, or OpenAI for analysis. Generated clips include burned captions and stable face-aware framing. Users sign in with Google and activate a paid test subscription.

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

To enable the admin panel, set `ADMIN_EMAILS` to a comma-separated list of Google account emails, for example `owner@example.com,team@example.com`. Admins can open `/admin` to inspect subscriptions, grant temporary plans, and create promo codes that activate plans without Stripe.

Create a PostgreSQL database and set `DATABASE_URL`, for example `postgresql://clipper:password@localhost/clipper`. The backend creates its tables at startup and stops with a clear error if the database is unavailable.

### Stripe test subscriptions

This integration accepts test mode only and rejects live keys and events. In the Stripe test Dashboard, create three monthly USD Prices for $9, $29, and $79 and put their IDs in `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, and `STRIPE_PRICE_STUDIO`. Set `STRIPE_SECRET_KEY` to an `sk_test_...` key.

Install the [Stripe CLI](https://docs.stripe.com/stripe-cli), then forward test webhooks while the backend is running:

```bash
stripe listen --forward-to localhost:8000/billing/webhook
```

Copy the printed `whsec_...` value to `STRIPE_WEBHOOK_SECRET` and restart the backend. Enable the Stripe Customer Portal with payment-method updates, cancellation, and subscription updates between the three configured prices. Use card `4242 4242 4242 4242`, any future expiry, and any CVC in Checkout. No real money moves in test mode.

User accounts, subscriptions, processed Stripe events, and balances are stored in PostgreSQL. New accounts start with zero credits. Each successful monthly invoice resets the balance to 100, 500, or 2,000 credits. A job reserves one credit per requested clip and automatically refunds failed or missing clips.

The Python launcher starts both servers and shuts down both process trees on `Ctrl+C`. If your Python command has a different name, use the same command that created `backend/.venv`.

Open http://localhost:3000. Keep the backend running while a job processes. Use one backend process; do not add `--workers`. Avoid auto-reload during processing.

## How it works

Browser → FastAPI background job → yt-dlp video and timestamped captions → selected AI model → validation/ranking → face-aware crop and captioned FFmpeg render → MP4 files. If captions are unavailable, FFmpeg extracts audio and Gemini creates a timestamped transcript first.

The standalone editor imports multiple local videos and audio files. Add sources to the timeline, split and trim clips, mix waveform-backed audio tracks with per-clip volume and fades, add crossfades, reframe for social aspect ratios, position captions directly in the preview, and export one MP4.

The backend requests at least 15 moments with timestamps, titles, reasoning and scores from the selected model, scaling the candidate pool for larger batches. Every score ranges from 0 (weak/absent) to 100 (exceptional). Candidates must have finite source-relative timestamps and match the selected length range. Ranking uses virality, standalone, hook, then earliest start; the greedy selector rejects overlapping moments. One additional request is allowed when the requested count is not met. If at least one moment survives, the job returns the best available clips and reports the actual count.

Virality is an editorial heuristic, not a prediction of views. Audio timestamp estimates can be imperfect, and a center crop can miss off-center speakers. There is no word alignment, face tracking, generated footage, or captions.

## Storage and API

Each job lives in `backend/data/<uuid>/` with its source, extracted audio, candidate JSON, atomic status JSON, and generated clips. Editor uploads and exports are stored under the same data directory. This directory is ignored by Git and must be on persistent storage. Finished jobs survive restarts; interrupted jobs are marked failed. Only one job runs at a time. Refreshing the browser restores the current job.

- `GET /health`: backend health.
- `POST /auth/google`: exchanges a Google credential for the user and a signed session token.
- `POST /auth/media-token`: creates a four-hour, path-bound URL token for authenticated media playback.
- `GET /ai/models`: configured Gemini, Anthropic, and OpenAI models.
- `GET /billing/plans`: plan prices, credits, and entitlements.
- `POST /billing/checkout`: authenticated Stripe test Checkout session.
- `POST /billing/portal`: authenticated Stripe Customer Portal session.
- `POST /billing/webhook`: signed Stripe webhook receiver.
- `POST /jobs`: `{ "youtube_url": "https://www.youtube.com/watch?v=...", "model": "gemini-fast", "instructions": "Prefer practical advice", "clip_length": "short", "clip_count": 5 }`, returns 202 and a job ID; 409 when busy. Length is `short`, `medium`, or `long`; count is 1, 3, 5, or 10.
- `GET /jobs/{id}`: actual stage, status, completed count, scores and errors.
- `GET /jobs/{id}/clips/{index}`: MP4 preview with range support; `?download=true` downloads it.

Stages reflect completed work, not estimated percentages. Cutting and vertical conversion are one encoding pass. The fallback audio upload is removed from Gemini after transcription where possible; a failed remote cleanup relies on the Files API expiry. Local files remain until you manually remove an individual job directory with the backend stopped. There is no automatic disk cleanup.

Use public videos you have permission to process. YouTube can block automated downloads or require sign-in; this app does not import browser cookies. Keep yt-dlp current if downloads stop working. Node is used by yt-dlp for YouTube's JavaScript challenges. Sources must be at least 75 seconds and within the configured duration limit.

## Deploy with Railway, Netlify, and Supabase

Production runs as one Railway backend replica, one Netlify site, and one Supabase PostgreSQL database. Do not run `start.py` in production and do not add Uvicorn workers: jobs and the processing lock live in the backend process.

1. Create a Supabase project. In **Connect**, copy the **Session pooler** URL on port `5432`, replace the password, and append `?sslmode=require` (or `&sslmode=require` if it already has query parameters). No SQL migration is required for a clean database; the backend creates its tables at startup.
2. Import this repository into Netlify. The root `netlify.toml` builds the `frontend` directory. Reserve the generated `https://YOUR-SITE.netlify.app` URL.
3. Import the same repository into Railway. Railway automatically detects the root `Dockerfile`; leave Root Directory, Dockerfile Path, and Custom Start Command empty. Generate a public domain, keep one replica, and set `/health` as the healthcheck path.
4. Attach a Railway volume at `/data`. Start with enough space for source videos and exports (20 GB is practical); there is no automatic cleanup.
5. Add these Railway variables:

```text
APP_URL=https://YOUR-SITE.netlify.app
DATABASE_URL=postgresql://...pooler.supabase.com:5432/postgres?sslmode=require
DATA_DIR=/data
AUTH_SECRET=at-least-32-random-characters
AUTH_COOKIE_SECURE=true
GOOGLE_CLIENT_ID=...
ADMIN_EMAILS=owner@example.com
GEMINI_API_KEY=...
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_STUDIO=price_...
YOUTUBE_COOKIES_GZIP_BASE64=...
```

Only one AI provider key is required, but Gemini is also the captionless-video transcription fallback. Generate `AUTH_SECRET` with `openssl rand -hex 32`. Keep every secret in Railway, never Netlify.

Railway IPs may be challenged by YouTube. Export a filtered Netscape-format cookie file from a browser session that can watch YouTube, run `gzip -c youtube-cookies-filtered.txt | base64 -w0`, and save the output as Railway secret `YOUTUBE_COOKIES_GZIP_BASE64`. Redeploy after changing it. Cookies expire and must occasionally be exported again; never commit the cookie file or encoded value.

6. In Netlify, select the Next.js runtime and set Base directory to `frontend`, Package directory empty, Build command to `npm run build`, Publish directory to `.next`, and Functions directory empty. Set `NEXT_PUBLIC_API_URL=https://YOUR-BACKEND.up.railway.app`, then clear the build cache and redeploy. This value is compiled into the browser bundle, so changing it always requires a new frontend build.
7. In Google Cloud, add the exact Netlify URL to the Web client’s **Authorized JavaScript origins**.
8. In the Stripe **test-mode** Dashboard, add `https://YOUR-BACKEND.up.railway.app/billing/webhook` and subscribe to `checkout.session.completed`, `checkout.session.expired`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`. Put that endpoint’s signing secret in Railway and redeploy.

Verify `/health`, Google login, test checkout, webhook activation, one short clip generation, clip download, editor upload/export, and plan switching. Restart the Railway service once and confirm completed files still load from the volume. Railway deployments with a mounted volume can have brief downtime; interrupted jobs are marked failed and their reserved credits are refunded on restart.

## Checks

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database to include the account and billing integration tests. Those tests truncate their three tables and are skipped when the variable is absent.

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
