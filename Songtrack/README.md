# Songtrack

Piano recording, tagging, sharing, and non-destructive editing. See [plans/INITIAL_PLAN.md](./plans/INITIAL_PLAN.md)
for the full design and rationale.

## Development

```bash
cp .env.example .env   # fill in NUXT_OAUTH_GOOGLE_CLIENT_ID/SECRET and NUXT_SESSION_PASSWORD
pnpm install
pnpm dev
```

Requires Node 24 and a system `ffmpeg` binary on PATH.

## Bulk-importing an existing folder of recordings

```bash
pnpm import -- /path/to/folder --user you@example.com
```

Idempotent (hashes file content), and preserves each file's mtime as its `created_at`.

## Testing

```bash
pnpm test           # vitest — pure-function unit tests (timeline resolution, auto-trim analysis)
pnpm exec playwright install chromium   # once, to fetch the browser binary
pnpm test:e2e       # playwright — full-app e2e, starts its own dev server on an isolated DB
```

The e2e suite runs against a real headless browser with its own SQLite database
(`.data-e2e/`, gitignored) and Google OAuth bypassed via a `_test-login` route
that's a 404 unless `ALLOW_TEST_LOGIN=true` — Playwright sets that only for its
own server, so it stays inert in normal dev/production runs. One spec drives
the recorder with a fake microphone device (`--use-fake-device-for-media-stream`),
feeding it `tests/e2e/fixtures/test-tone.wav`.

## Production deploy

```bash
docker compose up -d --build
```

The container binds `127.0.0.1:3000`. Point your reverse proxy at it — nginx example:

```nginx
server {
    listen 443 ssl;
    server_name songtrack.nebtown.info;

    client_max_body_size 512m;
    proxy_read_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Manual one-time steps:
1. Add `https://songtrack.nebtown.info/api/auth/google` as an authorized redirect URI in Google Cloud Console.
2. Make sure `.env` has a real `NUXT_SESSION_PASSWORD` (32+ chars) before first boot.

Audio and the SQLite DB persist in the `songtrack-data` Docker volume, mounted at `/data`.
