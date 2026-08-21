# Fittown HTTP smoke-test recipe (curl, no browser)

Fast endpoint-level verification of a Fittown feature against a live dev server.
Use this instead of `scripts/e2e.mjs` when you want a quick offline check and
don't have Playwright/browser available. Verified against a friend-sharing feature.

## Boot the server on a throwaway DB

```bash
nvm use 24
FITTOWN_DB_PATH=/tmp/x.db NUXT_PORT=3100 node_modules/.bin/nuxi dev   # background
```

Wait for `Local: http://localhost:3100/` in the log, then hit it.

## Three signed-in users

Each gets a curl cookie jar. **Dev login lives under `server/routes/`, so the path
is `/auth/dev` (NOT `/api/auth/dev` — the `/api/` form 404s).**

```bash
CKA=/tmp/ck-a; CKB=/tmp/ck-b; CKC=/tmp/ck-c; rm -f $CKA $CKB $CKC
curl -s -c $CKA -X POST http://localhost:3100/auth/dev -H 'Content-Type: application/json' -d '{"email":"alice@x.test","name":"Alice"}'
curl -s -c $CKB -X POST http://localhost:3100/auth/dev -H 'Content-Type: application/json' -d '{"email":"bob@x.test","name":"Bob"}'
curl -s -c $CKC -X POST http://localhost:3100/auth/dev -H 'Content-Type: application/json' -d '{"email":"carol@x.test","name":"Carol"}'
```

## Establish a friendship over HTTP (not by inserting rows)

```bash
INV=$(curl -s -b $CKA -X POST http://localhost:3100/api/friends/invites -H 'Content-Type: application/json' -d '{"note":"smoke"}')
TOKEN=$(echo "$INV" | python3 -c "import sys,json;print(json.load(sys.stdin)['invite']['token'])")
ACCEPT=$(curl -s -b $CKB -X POST "http://localhost:3100/api/friends/invites/$TOKEN/accept")
ALICE_ID=$(echo "$ACCEPT" | python3 -c "import sys,json;print(json.load(sys.stdin)['friend']['id'])")
```

## The three scenarios to assert (allow + both denies)

1. **Allow:** Bob (authed, friend, toggle ON) reads / searches / copies Alice's food.
2. **Stranger → 404:** Carol (authed, no friendship) must get 404 everywhere —
   never 403, so user existence isn't probeable.
3. **Friend, toggle OFF → 403 (browse) + excluded (search):**
   ```bash
   curl -s -b $CKA -X PUT http://localhost:3100/api/goals -H 'Content-Type: application/json' -d '{"share_custom_foods":0}'
   ```
   Then Bob's browse → 403 and Alice's row must vanish from Bob's search.

## JSON parsing (critical)

Server responses are **pretty-printed**, so string-grepping for `"\"id\":1"` silently
false-negatives — the number `1` is unquoted. Always parse with python3:

```bash
curl -s -b $CKB "http://localhost:3100/api/foods/search?q=Sourdough" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for r in d['results']: print(r['id'], r['owner_user_id'], r['name'])
"
```

Branch on parsed values (`[ -n "$ID" ]`), not on grep exit codes. If you must grep,
match the bare number for a numeric field.

## Cleanup

- Nuxt dev-lock **reuses the old server on the same port** until it's actually dead.
- Kill the shell wrapper, then kill lingering nuxi by pid:
  `ps aux | grep '[n]uxi' | awk '{print $2}' | xargs -r kill -9`
- Remove throwaway db/jar files: `/tmp/x.db* /tmp/ck-*`.