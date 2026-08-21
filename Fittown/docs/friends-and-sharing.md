# Friends, sharing & the access gate — full reasoning

**Every API route calls `requireUser(event)` and scopes queries by `user_id`.**
Deletes/updates use `WHERE id = ? AND user_id = ?` so a guessed ID is a no-op.
Keep that pattern.

**Friends are the *only* exception to that rule, and they get exactly one
gate.** `requireSharedSection(db, viewerId, ownerId, key)` in
`server/utils/friends.ts` is the single place that decides whether one person
may read another's rows. Every route under `server/api/friends/**` calls it
first; nothing else opens that door. If you add a friend-scoped endpoint, call
it — don't write your own join. A missed check here leaks a health diary, not a
preference. Two refusals, deliberately different:

- **404 for a stranger** — whether a given user id exists is not something an
  outsider should be able to probe, and "you have no such friend" is also the
  honest answer.
- **403 naming the person** when they *are* a friend but have switched that
  section off, so the page can say why instead of looking broken.

## Sharing is per-category

`share_recipes`, `share_diary`, `share_weight`, `share_calories`,
`share_exercise` on `user_goals`, all defaulting to 1. The catalogue lives in
`shared/sharing.ts`; Settings, the gate and the friend view all read it, so
adding a switch is one entry plus a column in both places (see the two-edit
rule). **An absent column reads as shared**, matching the default — a database
that predates the migration must not blank a friend's page. Enforcement is
server-side: `/api/friends/[id]/summary` strips the sections its owner withheld
on the way out, and the UI merely hides what it wasn't given.

## Token-addressed routes (the only unauthenticated ones)

**Two** token-addressed routes answer without a session, and they are the only
ones: `/api/shared/recipes/[token]` and `/api/friends/invites/[token]`. Both
take an unguessable token (16 random bytes, base64url) rather than an id, both
return one object and a display name, and every *mutation* behind them still
calls `requireUser`. `app/middleware/auth.global.ts` lets `/r/` and `/invite/`
through to match; everything else stays private by default.

## Copying a shared recipe is a deep copy

`copyRecipeInto()` references Open Food Facts ingredients as they are but
duplicates any ingredient that is somebody's *custom* food, because pointing at
a row you can't see gives you a recipe that changes when they edit it, vanishes
from your search, and pins their food in place for ever
(`recipe_ingredients.food_id` is ON DELETE RESTRICT). The duplicate drops its
barcode: `(source, barcode)` is unique, so carrying it across collides with the
row being copied.

## Friendship pairs, timestamps and link URLs

**A friendship row is unordered.** `idx_friendships_pair` is unique over
`MIN(requester_id, addressee_id), MAX(...)`, not over the ordered pair — two
people inviting each other at the same moment otherwise get two rows, one of
which stays pending for ever. `requestFriendship()` treats "I asked you while
you were asking me" as mutual consent.

**SQLite and JavaScript write timestamps differently** (`2026-08-16 12:00:00`
vs `2026-08-16T12:00:00.000Z`), and `' '` sorts before `'T'`. Comparing an
`expires_at` against `new Date().toISOString()` raw makes a link read as expired
for the rest of the day it was issued. `comparableTime()` in `shared/friends.ts`
normalises both; use it rather than comparing strings by hand.

**Link URLs are composed in the browser, from `window.location.origin`.** The
API returns tokens only. Deriving a public URL server-side means guessing the
hostname and scheme from request headers — the same guess that broke Google
sign-in behind nginx (§6).
