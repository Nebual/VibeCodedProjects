# Open Food Facts is crowd-sourced and dirty

`scripts/import-off.mjs` streams a 1.3 GB gzipped CSV and filters as it goes;
the ~10 GB uncompressed file is never written to disk. Don't "simplify" it into
downloading the file first — disk here is tight.

Real hazards already handled, with the reasoning in comments:

- **Unit-entry errors.** A blanket "≤100 g per 100 g" check passes a value that
  becomes 9,375,000 µg of vitamin D. Every nutrient has a per-nutrient
  physiological ceiling *in its output unit*. Pure salt legitimately is ~38,800
  mg sodium/100 g, so the caps are generous but finite.
- **kJ typed into the kcal field.** Stated calories are cross-checked against
  the Atwater estimate; macros win if they disagree by more than 2×.
- **Category umbrellas.** `"Plant-based foods and beverages"` sits on oats and
  olive oil and contains the word "beverages" — it mis-flagged 29,228 foods as
  liquids. `scripts/lib/liquid.mjs` strips `foods and beverages` umbrellas
  before matching, and only accepts a liquid word in final position in a name.
  62% of products have no categories at all.
- **Duplicates.** Many near-identical rows per product. Search de-duplicates by
  name+brand **in SQL, before the limit** — dedup after a small over-fetch
  collapsed "cheerios" to a single result.

If you change classification rules, `scripts/fix-liquid-flags.mjs` recomputes
in place (~10 s) instead of a two-minute re-import.

The addeds-sugars handling lives in `docs/nutrients-and-units.md` (the pure
added-sugar rule); the backfill is `scripts/fix-added-sugars.mjs`.
