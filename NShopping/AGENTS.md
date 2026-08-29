# Notes for agents

Context that isn't obvious from reading the code. For what the app *does*, read `README.md`.

## Environment traps (read this first)

- run `nvm install`
- A failed install leaves a ~225MB **partial `node_modules`** in the project. Delete it —
  the repo is normally checked out without one.

**The suite is green as of 2026-08-29.** 

## Photo OCR — why it's built this way

The take-a-photo flow in `BulkAddModal.vue` was added on top of the existing bulk-paste
pipeline. The key decisions:

- **OCR output fills the draft textarea; it does not auto-match.** Handwriting OCR makes
  real mistakes (observed: `BIB` → `Beef BfB`, `Flat` → `Fltr`), so the user reviews the
  text before `splitBulkInput` + `bestMatch` run. A misread stays a quick edit rather than
  becoming a wrong match. Explicit user choice — don't "streamline" it away.
- **`shared/matching.ts` is the OCR error-correction layer.** It already recovers most
  character-level slips. That is why a mid-tier OCR model is good enough here; don't reach
  for a bigger model to fix a fuzzy-matching problem.
- **The browser never calls the OCR server.** `POST /api/ocr` proxies it so the GPU box is
  never exposed and there's no CORS surface. Compose publishes to `127.0.0.1:8191` only.
- **The client resizes to 768px before upload** (`toResizedDataUrl`, EXIF-aware). This is a
  latency lever, not a bandwidth one — see below. The server route deliberately does no
  resizing; it trusts the client and only rejects absurd payloads.
- `OCR_SERVER_URL` (default `http://localhost:8191`) makes the topology configurable. Same
  box was the chosen deployment, but don't hardcode it.

## The hardware/model decision (already settled — don't redo it)

Target box has an **AMD RX 580 (Polaris / `gfx803`)**. Model is **Qwen3-VL 2B Q8_0**
via `llama-server` (switched from Qwen2.5-VL 3B Q4_K_M — the `ocr-benchmark/` harness
showed it slightly faster and more accurate). Requires a rebuilt image, since
`ocr-benchmark/Dockerfile` clones llama.cpp master and older builds don't know Qwen3-VL.

- **Vulkan, never ROCm.** AMD dropped Polaris from ROCm, so Ollama's AMD path can't use this
  card at all. `ocr-benchmark/Dockerfile` builds llama.cpp with `-DGGML_VULKAN=ON` and
  drives the card through Mesa RADV. Only `/dev/dri` is passed through — **not** `/dev/kfd`.
- Build deps that are easy to miss: `glslang-tools` + `spirv-headers` (CMake configure fails
  without them), and `libssl-dev` with `-DLLAMA_OPENSSL=ON` (else `-hf` model downloads fail
  with "HTTPS is not supported" — llama.cpp replaced libcurl with a native downloader).

**Measured, model resident, 768px, Qwen2.5-VL 3B Q4_K_M** (`ocr-benchmark/run-server.sh`) —
**stale**, from before the Qwen3-VL-2B switch; re-run `run-server.sh` and replace this table
before relying on the numbers below for the current model:

| | Total | Prefill | Generation |
|---|---|---|---|
| GPU (RX 580) | ~5.03s | 4.10s / 619 tok | 0.87s / 51 tok (58 tok/s) |
| CPU | ~9.2s | 5.13s / 619 tok | 4.05s / 50 tok (12 tok/s) |

Read those numbers carefully before optimizing:

- **~81% of GPU latency is prefill** (encoding image tokens). Generation is negligible. So
  **resolution is the only real optimization lever** — prefill scales roughly linearly with
  image tokens (~151 tok/s). 640px or 512px were projected at ~3.8s / ~2.9s but were never
  measured; if latency matters, sweep `RES=` and check the text still reads correctly.
- The GPU beats CPU only **1.25× on prefill** but **5× on generation**. That asymmetry
  suggests the **vision encoder (ViT) is still running on CPU** in both cases. Unverified.
  If someone wants faster prefill, that's the thread to pull, not a bigger GPU.
- CPU-only was rejected on latency (9.2s vs a 5s target) but the user called 9.2s
  "tolerable"; GPU was chosen mainly to keep load off the CPU. If the GPU is ever
  unavailable, CPU is a viable fallback — no code change needed, just `-ngl 0`.

**Benchmark methodology gotchas** (both bit us):

- Always measure with the **model resident** (`run-server.sh`), never one-shot
  (`benchmark.sh`). One-shot wall-clock includes model load + VRAM upload and overstated
  latency by ~2×. `benchmark.sh` is only a "does it work" smoke test.
- At `temp 0`, different resolutions are *different inputs* producing different-length
  output, so a naive resolution sweep can show CPU-768 as slower than CPU-1024. Compare the
  server's **prefill vs generation split**, not just wall-clock.
- Anything large (base64 images) must never touch `argv` — `jq --rawfile` and `curl -d @file`,
  or you get `Argument list too long`.
- Vulkan enumerates `llvmpipe` (software) alongside the real GPU. Confirm the server logs
  pick `POLARIS`, or "GPU" numbers are silently CPU numbers.

## Tags — why they're built this way

- **`TAG_COLORS` is a running order, not a palette.** `tagRank` turns its index into the
  sort key used by `compare()` in `useShoppingList.ts`, so reordering that array reorders
  every list in the app. Untagged returns `-1` deliberately — new items stay at the top of
  the "to buy" block, which is the one place you'd look for something you just typed.
  Bought items are *not* grouped; that pile is a record, and shopping order stops being
  the useful order once a thing is in the trolley.
- **No icon library is installed.** Every icon in this app is a hand-rolled inline SVG.
  The request named `i-mdi-store-remove`, but that's an Iconify/UnoCSS class and there is
  no such pipeline here — adding one means a dependency `pnpm install` can't install in
  the sandbox (see above), for two glyphs. `TagSymbolIcon.vue` draws them inline instead.
- **Symbol ids are neutral, labels aren't.** The id is `other-store`; only
  `TAG_SYMBOL_LABELS` says "Not at Costco". Renaming the label doesn't touch stored data.
- **Tag colours are mixed, not hardcoded.** `main.css` defines one ink colour per tag and
  derives row tint, swatch and stripe from it with `color-mix` against the theme's own
  `--color-base-*`. That's what keeps one set of values working on both themes. The
  light/dark split has to repeat the rule DaisyUI is configured with — `[data-theme="dim"]`
  *and* `prefers-color-scheme` guarded by `:not([data-theme="emerald"])` — because `system`
  sets no attribute at all. These classes are unlayered, so they win over Tailwind
  utilities; don't also put a `bg-*` utility on a `.tag-row`.
- **The row stripe is a background gradient, not a border or a child.** A thicker left
  border would shift a tagged row's contents 3px against its untagged neighbours and break
  the alignment of the checkbox column down the page.
- **Tagging is a mode, not a per-row control**, because colours describe aisles and are
  assigned a dozen at a time. The selection survives applying a tag on purpose.
- **In the bulk-add review, the picker lives in the footer**, not in a dropdown on each
  row: that list is `overflow-y-auto`, and a popover opened inside it gets clipped by its
  own scroll container. The row button just aims the footer picker.
- **`MAX_OPS_PER_FLUSH` exists because of "Select all".** One tap can now dirty more items
  than `MAX_OPS_PER_REQUEST` allows, and a 413 is a failure the retry loop can never clear
  — it would leave the list stuck offline. Keep the two constants equal, and note that
  `flushOnExit` has to cap itself as well: on the way out there is no retry to notice.
- **In the bulk-add review, an inherited tag is not a chosen one.** A row adopts the tag of
  whatever it matched, purely for display. `choseColor`/`choseSymbol` record what the *user*
  set, per facet. Collapsing the two — or tracking them with a single flag — reintroduces
  two real bugs: rejecting a match left its colour on the row, which then repainted the next
  item matched; and an explicit "No colour" was indistinguishable from silence, so it got
  re-inherited on the next match.
- **`entry.restore` means "we changed something", not "it was bought".** Tagging is the
  first thing that touches an item which was already to buy, so `pick()` captures the
  snapshot lazily. The "already to buy" label reads `wasToBuy` instead, which is why that
  field exists.
- **"Costco only" is a view filter and nothing else.** It hides rows wearing
  `other-store` and is remembered in `localStorage` (`nshoppinglist:hide-other-store`),
  but it never touches stored items, and it deliberately does *not* narrow `exactMatch` /
  `canAdd`: typing the name of a hidden item must still be recognised as already on the
  list, or the filter would quietly manufacture duplicates. It *does* narrow the "N to
  buy" count — a count including things you can't buy here is the wrong number to shop
  against — which is exactly why the `+N at another shop` button next to it isn't
  decoration. The filter outlives a reload, so something has to say what's missing.
- **`OTHER_STORE_FILTER_LABEL` is separate from `TAG_SYMBOL_LABELS['other-store']`** for
  the same reason the label is separate from the id: "Costco only" is not derivable from
  "Not at Costco", and both are the user's vocabulary, so both live in `shared/tags.ts`.
- **`applyRemote` calls `scheduleSort` when a colour arrives from another device.**
  `reconcileOrder` only files *new* ids, so without it the grouping — the entire point of a
  colour — never appears on the other phone.

## Two thresholds: claiming vs offering

`MATCH_THRESHOLD` (0.62) is what `bestMatch` claims on its own when a bulk paste is
submitted. `SUGGEST_THRESHOLD` (0.5) is what the review offers on a row it has already
left unresolved. `bestMatch` takes the bar as a third argument; only `BulkAddModal`'s
`rows` computed passes the lower one.

- **The gap exists for one specific shape, and it is structural, not tuning.** A one-word
  note against a longer item name scores `0.55·similarity + 0.20·density + 0.10·leading`;
  with density 0.5 and the match landing on a non-first word that caps at
  `0.55·similarity + 0.10`, so it needs similarity ≥ 0.945 to clear 0.62 — and only an
  identical token (1.0) or a plural (0.97) ever gets there. **No typo can auto-match in
  that shape, however mild.** "crakers", "yoghurt" and "bannana" all land on exactly 0.571
  and used to become duplicate items. Making them auto-match means reweighting the reverse
  branch, which also loosens every clean shorthand ("milk" → "coconut milk" would go 0.65 →
  0.75). Offering them instead costs nothing.
- **Lowering the *offer* bar cannot resurrect a lookalike.** `pecans`/`Pears`,
  `milk`/`Silk`, `corn`/`Cord` all score a flat **0**, because that separation is the work
  of the per-token edit budget in `tokenSimilarity`, not of the threshold. The band between
  0.5 and 0.62 contains only the typo'd-shorthand case. Measure before assuming otherwise.
- **Enter on an unresolved row only takes a suggestion at or above `MATCH_THRESHOLD`**
  (`resolveFromKeyboard`). Otherwise lowering the offer bar would quietly change what a
  keystroke does; a weak suggestion is an offer, and an offer should cost a deliberate tap.

## OCR line splitting

`splitBulkInput` treats a run of `+`/`-` **detached by whitespace on both sides** as a new
item, because photographed handwriting constantly runs the next bullet onto the end of the
previous line. Three details are load-bearing and each one was a bug first:

- **Whitespace on both sides** is the entire guard against eating `half-and-half`,
  `gluten-free bread` and `vitamin B+`. Don't relax it.
- **`+` is in `LIST_MARKER_RE` too**, not just the separator. A leading `+ ` has no space
  in front of it, so it never matches the separator; without it in the marker set,
  `+ milk` is added as an item literally called `+ milk`.
- **The separator is `[-+–—]+`, not `[-+–—]`.** A double-struck dash — or an em-dash OCR
  read as `--` — would otherwise fail to split and silently swallow the second item.

`HAS_CONTENT_RE` requires a **letter**, not just any alphanumeric: splitting strands a
trailing quantity as its own segment (`apples - 2`), and a bare `2` is a row that can never
match anything and can only be deleted.

The known cost is that `milk - the 2% one` splits in two; that was accepted knowingly (a
stray line is one tap, a swallowed item isn't noticed until you're home). The OCR prompt
asks for these characters back explicitly, so don't "tidy" that instruction out of
`server/api/ocr.post.ts`.

## Ticking off — the five-second undo

`nextBoughtState` in `shared/bought.ts` is the whole of the tick/untick date logic, kept
pure so it can be tested without booting Nuxt. `useShoppingList` holds the one piece of
state it needs: `beforeFlip`, a client-only map of how each item looked before its last
flip.

- **The window exists because both flips destroy a date.** Ticking overwrites `boughtAt`;
  unticking overwrites `addedAt`. So a stray tap and its correction between them lose the
  real purchase date *and* the real add date, and no later tap can recover either.
- **`stateAt` is restored along with the other two, and that is load-bearing.** It is what
  stops the undo cascading: after a restore the item carries its old age again, so the
  next flip fails the `at - item.stateAt < FLIP_UNDO_WINDOW` test and is judged normally.
  Drop it and tick–untick–tick reads the third tap as an undo of an undo.
- **`updatedAt` is never restored.** It's the last-writer-wins clock; freezing it would
  leave the correction losing to the mis-tap on every other device.
- **`FLIP_UNDO_WINDOW` matches `SORT_DELAY` on purpose** — inside it the list hasn't
  re-sorted, so the row you tap is still the row you meant. Changing one without the other
  means a tap can land on a row that has already moved.
- The snapshot is memory, not data: it never reaches the server or disk, and
  `restoreItem` clears it, since a bulk-match undo has already put the item back whole.

## Conventions worth matching

- Server routes are thin `defineEventHandler`s; config comes from `process.env` with a
  sensible default (see `NSHOPPING_DATA_DIR` in `server/utils/listStore.ts`).
- `createError` is imported explicitly from `h3` rather than relying on Nitro auto-import,
  so modules stay unit-testable outside the server runtime. Follow that.
- Comments in this codebase explain *why*, not *what*, and are written in prose. Match that
  register — it's consistent throughout and clearly deliberate.
- Tests cover pure logic only (no Nuxt boot), with `#shared` aliased by hand in
  `vitest.config.ts`.
