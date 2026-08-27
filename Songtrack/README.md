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

## Audio → MIDI transcription

Songs can be transcribed to MIDI and engraved as sheet music. The model runs in a
separate `midi` sidecar container (upstream [MuScriptor](https://github.com/muscriptor/muscriptor)
plus MuseScore Studio for engraving); Nuxt owns auth, ownership, storage and caching
and proxies the sidecar's Server-Sent Events stream straight to the browser.

Three one-time setup steps on the server, none of which run from a deploy:

```bash
export HF_TOKEN=hf_...            # after accepting the licence, see the script header
./bin/fetch-midi-model.sh medium  # populates ./cache/midi-cache (~1.2 GB, gitignored)
./bin/build-midi-sidecar.sh   # pinned commit + patches/; see the script header
docker compose up -d
```

The sidecar is deliberately never published to a host port — it has no authentication
of its own, and the only thing allowed to reach it is the Songtrack container. Verify
after a deploy that `curl --max-time 3 http://127.0.0.1:8000/health` from the host
*fails to connect*.

For local development without the sidecar, set `MIDI_FAKE_WORKER=true` to replay a
canned event stream from `tests/e2e/fixtures/transcribe-stream.jsonl` — this is what
the Playwright suite runs against.

### What this sidecar build can and cannot do

Verified against a live `muscriptor` sidecar, which is worth knowing because the version you build
changes what works. On the pinned commit the routes are `/health`, `/instruments`,
`/soundfonts/MuseScore_General.sf3`, `/transcribe`, `/transcribe/midi`, `/auralize` and `/sheets`;
on the v0.3.0 tag the last of those does not exist.

- **Transcription, the piano roll, the tempo editor and both MIDI downloads work.**
- **Sheet-music engraving needs the pinned commit, not a release.** `/sheets` landed upstream after
  v0.3.0 and no tag carries it, so `bin/build-midi-sidecar.sh` pins commit `e34b397`. Built from
  the v0.3.0 tag instead, the Engrave button reports a 501 saying so and points at the Score MIDI.
- **The image is patched, not stock.** `patches/` adds two things upstream doesn't have: `.mscz`
  export, and a `tempo_hint` reporting the tempo the beat tracker fitted and then rejected (which
  otherwise survives only inside an exception message, leaving rubato recordings on a meaningless
  120 BPM placeholder). The build script refuses to build without the patches applied.
- **`/auralize` and the in-browser synth need `MuScriptor/assets` in the cache**, which
  `bin/fetch-midi-model.sh` now fetches alongside the weights. If you populated the cache before
  that, just re-run the script — the model download is already cached, so it only adds the
  soundfonts.

> **Licence note:** MuScriptor's *inference code* is MIT, but its **model weights are
> CC BY-NC 4.0**. Personal and family use is fine. Songtrack cannot be commercialised
> while this feature is enabled without a separate licence from Kyutai/Mirelo.

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
