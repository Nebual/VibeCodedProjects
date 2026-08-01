# NMediaTrack

Part **find-a-game**, part **backlog tracker**, part **personal reviews**.

Track the games, shows, movies and books you're consuming — who you're consuming them *with*,
where you left off, and what you thought. So when a friend asks "what should I read?" three years
from now, you can pull up the review you wrote while you were still excited.

Built with **Nuxt 4**, **Tailwind CSS v4**, **DaisyUI 5**, on **Node 24** + **pnpm**.
Data is stored in a plain **YAML** file — no database.

## Features

- **Media library** — games, shows, movies, books, other. Each with a status
  (backlog / active / paused / completed / dropped).
- **Last-played indicator** — every item shows "last played 3 weeks ago". Anything active or
  paused that's been untouched for 21+ days gets a **"⏳ pick back up?"** nudge, so things don't
  quietly rot in the backlog. The date is editable, so you can backdate something to push it out
  of the top of the list (or hit **Did this today** on the card to bump it).
- **Random button** — spotlights a random item from your current filter, scrolls to it and
  highlights it. For when you can't decide.
- **Episode tracking** — shows get a "last episode watched" field (`S2E6`), saved with the show and
  displayed on its card.
- **Reviews** — 1–5 stars plus a free-text message, with a dedicated Reviews page sorted by rating.
- **Consuming with others** — tag people on an item. This doubles as the sharing mechanism
  (see below) and as a way to find something to play together.
- **Tagged-in media on your Library** — anything someone else tagged you in appears alongside your
  own entries by default (read-only), toggled with the **Show tagged** checkbox.
- **Friend filter** — a multi-select dropdown of everyone in your visible media. Pick a few and the
  list narrows to media involving them, **sorted by how many of them are on each item** — so
  something all of you are in floats to the top. Handy for "what can the three of us play?"
- **Group size** — media with enough people tagged can be marked **Minimum 3** / **Minimum 4**
  (counting you) or **Soloable**. The friend filter respects it: a 4-player co-op marked
  *Minimum 3* stays hidden until you've picked enough of its people to actually field a game. The
  dropdown's **Solo** option flips to the opposite question — only things you can enjoy alone.
- **Light/dark theme** — sun/moon toggle in the navbar (daisyUI `nord` / `night`), remembered in
  `localStorage` and defaulting to your system preference. An inline head script applies it before
  first paint, so there's no flash of the wrong theme.

## Identity & sharing

There is **no authentication** — this is a personal/small-group tool. You type a name on first
visit and it's remembered in `localStorage`. That name is your identity:

- You **own** every item you create, and you can only edit or delete your own items.
- Tagging someone makes you friends. When Nebual adds *Helldivers 2* "with **Bishop**", Bishop can
  browse **all** of Nebual's media on his **Shared** page — grouped under "Nebual's list",
  **read-only**. One tag opens the whole list, not just the tagged item.
- Friendship is **directional**: Bishop tagging you lets you see Bishop's list; it doesn't let
  Bishop see yours until you tag him back. Someone nobody has tagged sees nothing.

Ownership is enforced server-side, not just in the UI — the API returns `403` if a non-owner
attempts a write.

## Pages

| Route      | What it does                                                             |
| ---------- | ------------------------------------------------------------------------ |
| `/`        | Your library + anything you're tagged in. Filter, search, sort, Random pick. |
| `/shared`  | Read-only lists from people who tagged you.                              |
| `/reviews` | Your reviews, highest-rated first, with average-rating stats.            |

## Setup

Requires **Node 24** and **pnpm**.

```bash
pnpm install
pnpm dev      # http://localhost:3000
```

```bash
pnpm build    # production build
pnpm start    # run the production server on http://localhost:8188
pnpm preview  # preview the production build, also on 8188
```

The production port is **8188**, set in [`.env.production`](.env.production) (`NITRO_PORT`) and
mirrored in the `preview` script's `--port`. It also sets `NITRO_HOST=0.0.0.0` so the port can be
published out of a container. A `PORT`/`NITRO_PORT` exported in the shell still overrides it.

## Data

Plain YAML, safe to hand-edit. One file per person, plus a registry that says who can see whose.
`server/data/` is gitignored, so each deployment keeps its own data:

```
server/data/
  friends.yml          who is tagged in whose list
  media/
    nebual.yml         one file per list owner
    bishop.yml
```

**`media/<who>.yml`** — the owner is declared once at the top, not repeated per item:

```yaml
owner: Nebual
media:
  - id: seed-severance
    title: Severance
    type: show          # game | show | movie | book | other
    status: active      # backlog | active | paused | completed | dropped
    companions:
      - Aria            # tagged people; grants them read access
    minPlayers: 3       # optional; counts the owner. Needs >= 2 companions
    soloable: true      # optional; only meaningful with >= 1 companion
    lastEpisode: S2E6
    lastActivityAt: '2026-07-28T21:00:00.000Z'
    createdAt: '2026-07-01T19:00:00.000Z'
    updatedAt: '2026-07-28T21:00:00.000Z'
    review:
      stars: 5
      message: Why this mattered.
      updatedAt: '2026-07-28T21:00:00.000Z'
```

**`friends.yml`** — `taggedIn` is the lookup that decides which media files to open for a viewer,
so building someone's view never reads every file:

```yaml
people:                # canonical (lowercased) name -> display name + their file
  aria:
    name: Aria         # no `file`: tagged by others, owns no list yet
  nebual:
    name: Nebual
    file: nebual.yml
taggedIn:              # person -> owners who tagged them
  aria:
    - nebual
```

`friends.yml` is **derived**, rebuilt from the media itself on every write, so the two can't drift.
Hand edits to it are overwritten the next time that list's owner saves. Point `NMEDIA_DATA_DIR` at
another directory to relocate the whole store. Writes are serialised through a promise chain so
concurrent requests can't clobber each other.

## API

| Method   | Route                       | Notes                                       |
| -------- | --------------------------- | ------------------------------------------- |
| `GET`    | `/api/media?user=Name`      | Items you own + full lists of anyone who tagged you. |
| `POST`   | `/api/media`                | Create. Body includes `owner`.              |
| `PUT`    | `/api/media/:id`            | Update. Body needs `actor`; owner-only.     |
| `DELETE` | `/api/media/:id?actor=Name` | Delete. Owner-only.                         |
| `GET`    | `/api/people?not=Name`      | Known names, for tag autocomplete.          |

## Project layout

```
app/
  app.vue                    # shell: navbar + name gate
  assets/css/main.css        # Tailwind v4 + DaisyUI theme setup
  components/
    MediaCard.vue            # one item: status, episode, companions, review, last-played
    MediaFormModal.vue       # add/edit dialog
    NameGate.vue             # first-run name prompt
    PersonInput.vue          # tag-style "with whom" input
    StarRating.vue           # 1-5 star widget (interactive or readonly)
    ThemeToggle.vue          # sun/moon light-dark switch
  composables/
    useUser.ts               # name in localStorage
    useTheme.ts              # light/dark mode in localStorage
    useMedia.ts              # fetch + CRUD, mine/sharedWithMe split
  pages/                     # index, shared, reviews
  utils/time.ts              # timeAgo / daysSince / shortDate
server/
  api/media/                 # REST handlers
  data/friends.yml           # who is tagged in whose list (derived)
  data/media/<who>.yml       # one list per person
  utils/mediaStore.ts        # YAML read/write, visibility & ownership rules
shared/types.ts              # types shared by client and server
```

## Sandbox note

This project sits on a filesystem that doesn't support symlinks, which breaks `node_modules`.
`node_modules` is therefore a bind mount from a native directory. After a sandbox restart, run:

```bash
./ensure-node-modules.sh
```

`pnpm-workspace.yaml` also sets `verifyDepsBeforeRun: false` for the same reason — pnpm's
pre-script dependency check otherwise aborts `pnpm dev`.
