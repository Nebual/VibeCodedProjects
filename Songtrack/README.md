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
