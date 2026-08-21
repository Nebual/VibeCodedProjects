# Schema & the database — full reasoning

## Table-qualified columns and FTS

**`foodCols()` emits table-qualified columns** (`f.id, f.name, …`). Any query
using it needs `FROM foods f`. Both `foods` and `diary_entries` have `id` and
`created_at`, so unqualified lists are ambiguous or silently overwrite.

**`foods_fts` is an external-content FTS5 table.** The importer bulk-rebuilds
it; custom foods insert their own row in `server/api/foods/index.post.ts`. If
you add another path that creates a food, index it there too or it won't be
searchable. The e2e script asserts this.

**Renaming a food means re-indexing it.** `foods_fts` is external-content, so a
delete has to replay the *old* values — read them before the UPDATE and use
`reindexFood()`. Skip it and the old name keeps turning up in search.

## The dev login is double-gated

`import.meta.dev` *and* `FITTOWN_DEV_LOGIN=1`), and 404s in a production build
even with the env var set. Verified — don't loosen it.

## Migrations

**Changing a column's *type or nullability* takes a table rebuild, and there is
exactly one.** SQLite has no `ALTER COLUMN`, so `ADDED_COLUMNS` cannot express
it. `rebuildRecipeIngredients()` in `server/utils/db.ts` creates the new shape,
copies the rows, drops, renames and **recreates both indexes** (SCHEMA_SQL's
`IF NOT EXISTS` versions have already run this boot and will not put them back).
It is guarded on the thing it fixes — `food_id`'s `notnull` flag — rather than a
version number, so it is a no-op on every subsequent boot. It must run with
foreign key enforcement **off**, which is why `PRAGMA foreign_keys = ON` sits
*after* it in `useDb()` rather than up with the other pragmas; the pragma cannot
be changed inside a transaction. Verified against a copy of the shipped
`data/fittown.db`: 203,695 foods and their FTS rows intact, `quick_check ok`,
no foreign key violations.

**Adding a column takes two edits, not one.** `SCHEMA_SQL` is all
`CREATE TABLE IF NOT EXISTS`, which does nothing to a table that already
exists — so a new column there reaches fresh databases only, and every existing
one throws "no such column" on the next query. Add it to `SCHEMA_SQL` *and* to
`ADDED_COLUMNS` in `server/utils/db.ts`, which ALTERs it in on boot after
checking `PRAGMA table_info`. Entries in `ADDED_COLUMNS` are permanent; that
list is how an old database catches up. Verified against the shipped
`data/fittown.db` (old schema, 203,695 foods): it gains the columns on first
DB-touching request and loses nothing.

Note the migration is **lazy** — `useDb()` runs it on first use, so a request
that 401s before touching the database won't trigger it. That is fine in
practice and confusing when testing; hit an authenticated route.

**A maintenance script must call `ensureSchema()` before it reads anything.**
The app applies `ADDED_COLUMNS` *lazily*, on the first request that touches the
database, so a file that has not been served since the last release is missing
whatever that release added — and a script that opens it directly dies partway
through with a bare "no such column" (`f.logged_from_food_id`, from
`foodCols()`, is how this was found). `ensureSchema()` in `server/utils/db.ts` is
the same catch-up `useDb()` runs, factored out for exactly this: idempotent, a
no-op on a current database, and it must be called **before**
`PRAGMA foreign_keys = ON` because part of it rebuilds a table.
`snapshot-diary-recipes.mjs`, `recompute-recipes.mjs` and both importers all go
through it. `test/scripts-smoke.test.ts` runs the first two as real child
processes against a deliberately old fixture, which is the only way to catch
either this or the rule below.

**An import reachable from `scripts/` needs its `.ts` extension — including
transitively.** §5 says this about the scripts themselves; the trap is that it
applies to every module they reach. `server/utils/db.ts` imported
`'../db/schema'`, which Nuxt, Vite and Vitest all resolve happily and plain
`node` does not, so the whole thing failed with ERR_MODULE_NOT_FOUND the first
time a script imported it — while every test still passed. If you add an import
to anything under `server/utils/`, give it the extension.

**A new index over a newly-added column cannot go in `SCHEMA_SQL`.**
`db.exec(SCHEMA_SQL)` runs *before* `migrate()`, so on a database that predates
the column `CREATE INDEX ... ON foods(recipe_family_id)` fails with "no such
column" — `IF NOT EXISTS` suppresses the index-already-exists error and nothing
else — and takes the boot down for every existing user. `POST_MIGRATION_SQL` in
`server/db/schema.ts` runs immediately after `migrate()` instead. `migrate()`
now returns the set of columns it added, which is what lets a one-time backfill
(`recipe_family_id = id`) run exactly once rather than re-scanning 200k rows on
every boot.
