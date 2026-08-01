# NShoppingList

A shared grocery list. Open a URL, add things, tick them off; anyone else with the
same link sees the same list on their own phone.

## Running it

```bash
nvm use          # node 24, per .nvmrc
pnpm install
pnpm dev         # http://localhost:3000
```

Lists are stored as plain JSON files under `data/lists/<name>.json`. Set
`NSHOPPING_DATA_DIR` to put them somewhere else.

To run the production build:

```bash
pnpm build
pnpm start       # http://localhost:8187
```

## How it behaves

**Ordering.** Things still to buy sit at the top, newest first. Bought items fade
out below, most recently bought first. Ticking an item does *not* immediately
re-sort — the list holds its position until you've been idle for 5 seconds, so a
row never jumps away mid-tap.

**Buying vs. correcting.** Each item records when it was added to the list and when
it was last actually bought. If you tick something off within 20 minutes of adding
it, that's read as undoing a mistake rather than a shopping trip, and the
"last bought" timestamp is left alone.

**Deleting.** The per-item menu (and its Delete button, behind a confirmation) only
appears once an item is bought, so an active list can't be gutted by a stray tap.

**Theme.** Follows the OS by default; the menu can pin light or dark. The choice is
applied by a tiny inline script in `<head>` so an override never flashes the wrong
theme on load.

## Bulk add

The **Bulk** button next to the search box takes a pasted block of notes — one per
line, or comma separated — and matches each line against what's already on the list,
so restocking is a paste rather than a dozen taps.

Matching works on word tokens, not whole strings. Quantities (`x2`, `2x`, bare
numbers) and filler words (`the`, `some`, `any`) are dropped, then it looks for the
item's words appearing *in order* inside the note — which is what lets
`black beans totally empty I think` find **Black beans**. A shorthand note can also
sit inside a longer item name, so `salmon` finds **Canned salmon**.

Plurals are folded explicitly (`pecans` → `pecan`) so the typo budget can stay tight:
five letters or fewer must match exactly, because at that length nearly every near
miss is a different product — `pecans` must not match **Pears**.

The results view pairs each pasted line with what it hit and lets you disagree:
inexact matches offer **Change**, which undoes the match, stops suggesting the
rejected item, and lets you type an alternative. Unmatched lines can be edited until
they match, or added outright with **+**.

## Syncing

Edits are queued locally and pushed 3 seconds after you stop touching things; other
devices pick them up by polling every 4 seconds. A push sends *only the items you
changed*, never the whole list, and the server merges them per-item on a
last-writer-wins basis — so two people shopping off the same list at once don't
overwrite each other unless they happen to touch the very same item.

Deletes are tombstones so they propagate rather than getting resurrected by a
device that hadn't heard yet; they're pruned after 30 days. Clients correct for
device clock skew against the server clock, which keeps last-writer-wins honest.

| Route | |
| --- | --- |
| `/` | Bounces to your last list, or mints a new one |
| `/l/{name}` | That list |
| `GET /api/lists/{name}?rev=N` | Snapshot; `{unchanged: true}` if `rev` is current |
| `POST /api/lists/{name}` | `{ops: Item[]}` — merge these items, get the snapshot back |

## Tests

```bash
pnpm test
```

Vitest covers the pure logic, which is where the fiddly rules live: bulk-add matching
(`test/matching.test.ts`), list and backup name validation including path traversal
(`test/listName.test.ts`), and the JSON store's last-writer-wins merge, input hardening
and once-a-day backups (`test/listStore.test.ts`). They run in plain node — no Nuxt
boot — with `#shared` aliased by hand in `vitest.config.ts`.

Vite's transform cache is pointed at `/tmp` because this project sits on a network
mount; override with `VITEST_CACHE_DIR` if that doesn't suit.
