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

**Ordering.** Things still to buy sit at the top, newest first, then everything
carrying a colour tag, grouped by colour (see [Tags](#tags)). Bought items fade out
below, most recently bought first. Ticking an item does *not* immediately re-sort —
the list holds its position until you've been idle for 5 seconds, so a row never
jumps away mid-tap.

**Buying vs. correcting.** Each item records when it was added to the list and when
it was last actually bought. If you tick something off within 20 minutes of adding
it, that's read as undoing a mistake rather than a shopping trip, and the
"last bought" timestamp is left alone.

**Deleting.** The per-item menu (and its Delete button, behind a confirmation) only
appears once an item is bought, so an active list can't be gutted by a stray tap.

**Theme.** Follows the OS by default; the menu can pin light or dark. The choice is
applied by a tiny inline script in `<head>` so an override never flashes the wrong
theme on load.

## Tags

An item can carry a **colour** and a **symbol**. A colour stands for an area of the
shop — green for produce, yellow for bread, light blue for frozen — and the list
groups by it, so one colour is one stop rather than seven laps of the aisles. Which
colour means what is yours to decide; the app only fixes the order they come in.

Untagged items stay at the top of the "to buy" block rather than being filed at the
bottom, because that's where something you've only just typed is worth seeing.

Symbols mark an item out *within* its group and never move it: a **star**, and a
**Not at Costco** shopfront for things that need a different shop. (That label lives
in `TAG_SYMBOL_LABELS` in `shared/tags.ts` — rename it and nothing else moves, since
the stored id is the neutral `other-store`.)

**Applying them in bulk.** Tags are nearly always assigned a dozen at a time, so the
flow is built for that: **Select & tag** in the menu turns the checkboxes into a
selection, and a bar at the bottom applies a colour or symbol to everything ticked.
The selection survives applying one, so colour-then-symbol is two taps rather than
two rounds of re-selecting. Searching first and then **Select all shown** is the
quick way to tag a whole aisle at once.

Tags can also be set while reviewing a bulk add — see below.

## Bulk add

The **Bulk** button next to the search box takes a pasted block of notes — one per
line, or comma separated — and matches each line against what's already on the list,
so restocking is a paste rather than a dozen taps.

**Take a photo.** Inside the Bulk dialog you can snap a photo of a handwritten or
printed list instead of typing. It's OCR'd and the transcription drops into the same
paste box for you to glance over before matching — so a misread (handwriting isn't
perfect) is a quick edit, not a bad match. OCR runs on a local model; see
[Photo OCR](#photo-ocr) for the service it talks to.

Matching works on word tokens, not whole strings. Quantities (`x2`, `2x`, bare
numbers) and filler words (`the`, `some`, `any`) are dropped, then it looks for the
item's words appearing *in order* inside the note — which is what lets
`black beans totally empty I think` find **Black beans**. A shorthand note can also
sit inside a longer item name, so `salmon` finds **Canned salmon**.

Plurals are folded explicitly (`pecans` → `pecan`) so the typo budget can stay tight:
five letters or fewer must match exactly, because at that length nearly every near
miss is a different product — `pecans` must not match **Pears**.

Lines are split on newlines, commas and semicolons — and also on a `+` or `-` left
standing *between* words, which is how a photographed list runs several items onto
one line: `tuna - nutritional yeast + garlic` is three things, while a leading
`- crackers` is just a bullet. Whitespace on both sides is what does the work, so
`half-and-half`, `gluten-free bread` and `vitamin B+` stay in one piece. The
trade-off is deliberate: a genuine aside like `milk - the 2% one` becomes two lines,
which is one tap to delete, whereas a silently swallowed item isn't noticed until
you're home.

The results view pairs each pasted line with what it hit and lets you disagree:
inexact matches offer **Change**, which undoes the match, stops suggesting the
rejected item, and lets you type an alternative. Unmatched lines can be edited until
they match, or added outright with **+**.

Each row also carries a tag button. It aims the picker at the foot of the dialog at
that row — or leave it aimed at **all** rows to tag the whole paste in one go, which
is the common case when a photo is one trip's worth of one aisle. A row that hasn't
resolved to anything yet still holds its tag, and hands it over the moment it does;
a row that matches an item which is *already* tagged shows that tag rather than
quietly clearing it.

## Photo OCR

The take-a-photo flow needs a local OCR model running. It's a `llama-server` instance
serving **Qwen3-VL-2B** (an image-to-text model), GPU-accelerated on an AMD RX 580 via
Vulkan, packaged as a compose service:

```bash
docker compose up -d ocr     # first boot downloads ~2.5GB, then stays resident
```

The browser never talks to it directly — the app's `POST /api/ocr` route resizes-nothing
(the client already shrank the photo to ~768px) and forwards it, so the GPU box stays off
the public internet. The route reaches the model at `http://localhost:8191`; override with
`OCR_SERVER_URL` if you run it elsewhere. Per-photo latency is ~5s on the RX 580.

Why Vulkan and not ROCm: the RX 580 is Polaris, which modern ROCm (and Ollama's AMD path)
dropped, so the container drives the card through Mesa RADV instead. The `ocr-benchmark/`
directory has the latency harness used to pick the model, resolution, and GPU-vs-CPU call.

## Syncing

Edits are queued locally and pushed 3 seconds after you stop touching things; other
devices pick them up by polling every 4 seconds. A push sends *only the items you
changed*, never the whole list, and the server merges them per-item on a
last-writer-wins basis — so two people shopping off the same list at once don't
overwrite each other unless they happen to touch the very same item.

A push carries at most 500 items, which is the server's limit; bulk tagging can queue
more than that in a single tap, so the rest follows in the next batch rather than
becoming a rejection the retry loop can't clear.

Deletes are tombstones so they propagate rather than getting resurrected by a
device that hadn't heard yet; they're pruned after 30 days. Clients correct for
device clock skew against the server clock, which keeps last-writer-wins honest.

| Route | |
| --- | --- |
| `/` | Bounces to your last list, or mints a new one |
| `/l/{name}` | That list |
| `GET /api/lists/{name}?rev=N` | Snapshot; `{unchanged: true}` if `rev` is current |
| `POST /api/lists/{name}` | `{ops: Item[]}` — merge these items, get the snapshot back |
| `POST /api/ocr` | `{image: dataUrl}` — transcribe a photo of a list to `{text}` |

## Tests

```bash
pnpm test
```

Vitest covers the pure logic, which is where the fiddly rules live: bulk-add matching
and line splitting (`test/matching.test.ts`), the tag vocabulary and the ordering it
implies (`test/tags.test.ts`), list and backup name validation including path traversal
(`test/listName.test.ts`), and the JSON store's last-writer-wins merge, input hardening,
tag round-tripping and once-a-day backups (`test/listStore.test.ts`). They run in plain
node — no Nuxt boot — with `#shared` aliased by hand in `vitest.config.ts`.

Vite's transform cache is pointed at `/tmp` because this project sits on a network
mount; override with `VITEST_CACHE_DIR` if that doesn't suit.
