# Photo → structured data via the shared local vision model

Fittown OCR's *physical* photos (recipe pages, Nutrition Facts labels) against a
llama-server on the household LAN — no third party sees the image, no per-request
cost. Two consumers exist: `server/utils/recipeOcr.ts` (recipe) and
`server/utils/labelOcr.ts` (label). Add a third the same way.

## Shared wiring (do this for every consumer)

- **Config:** read `useRuntimeConfig().recipeOcr` → `{ baseUrl, model }`, set by
  `NUXT_RECIPE_OCR_BASE_URL` / `NUXT_RECIPE_OCR_MODEL` (see `.env.example`). No
  new env var for a new consumer — one vision box serves all.
- **On/off flag:** the client shows the capture button only when
  `public.recipeOcrEnabled` (`nuxt.config.ts` computes it from the same env var).
- **Image upload:** resize client-side to ≤1600px max dimension and re-encode as
  JPEG via `app/utils/resizeImage.ts` (moved out of `recipes/import.vue` so label
  scan can reuse it) — a raw phone photo can be 10+ MB.
- **Route** (`server/api/.../<feature>.post.ts`): `await requireUser(event)`; 503
  when `baseUrl` unset; hand-check `body.image` matches
  `/^data:image\/(jpeg|jpg|png|webp);base64,/` and stays under ~8 MB (do NOT use
  `assertText` — it `.slice()`-truncates instead of rejecting); map `LabelOcrError`
  / `RecipeOcrError` to 422.
- **Transcribe:** POST `new URL('/v1/chat/completions', baseUrl)` with
  `temperature: 0`, a system prompt requesting a strict JSON shape, and the
  message `[{type:'text'}, {type:'image_url', image_url:{url: dataUrl}}]`.
  AbortController timeout ~120s.
- **Parse:** `parseXxxResponse()` pulls the substring between first `{` and last
  `}` (models wrap in code fences / add a preamble), validates shape, and is a
  pure function unit-tested without a model.

## Label-specific mapping (the case with real edge cases)

The model returns `{serving_label, serving_grams, nutrients:[{name, value}]}`.
The name→canonical-nutrient-key mapping lives **in code, not the prompt**:

- **Bilingual labels:** `name.split('/')[0]` keeps only the English side
  (`"Fat / Lipides"` → `fat_g`). "of which X" is stripped.
- **Normalise** by lowercasing + stripping non-alphanumerics so
  "Saturated Fat" / "Saturated" / "of which Saturates" all key to `sat_fat_g`.
- **Anything unmappable is dropped** — this is what ignores "% Daily Value",
  and means a stray line simply doesn't prefill a field.
- Accept `nutrients` as either an array of `{name,value}` (the model's usual)
  or a name→value object (some models produce this).
- **Serving:** parse grams out of the label text as a fallback when
  `serving_grams` is absent (`"Per 3 bars (45 g)"` → 45). Reject values < 0.1.

## Frontend prefill (label consumer example)

`app/pages/food/new.vue`: a `BASE_NUTRIENT_KEYS` set holds nutrients the base
form already renders (kcal + 4 macros + fiber/sugars/sat_fat/sodium); anything
the scan returns outside that goes into a reactive `extraNutrients` object that is
rendered as extra inputs (only after a scan finds them) and spread into the save
body — the foods POST already reads every `NUTRIENT_KEYS` column, so no route
change is needed to persist calcium/iron/etc.
