# What is and isn't proven, and known gaps

## Verified working

The full logging journey (e2e script), search (22–104 ms over 203,695 foods),
barcode lookup incl. UPC-A/EAN-13 zero-padding and 404s, custom foods, goals,
trends, dark mode, production build, the production security posture (dev login
404, API 401, `/` redirects), and — as of the user's own deployment — **Google
sign-in end to end**, behind nginx with TLS termination.

Friends and sharing were checked with three signed-in people and an anonymous
visitor: request by email → prompt → accept, invite links (multi-use,
cancellable, self-accept refused, previewable signed out), a friend's trends /
recipes / diary, each of the five switches closing its own door on the *server*
(403) and not merely in the UI, copying by friendship and by public link,
revocation (410, with copies already taken unaffected), and unfriending (access
stops at once, copies survive, and the two can start over). In production: every
friend and copy route 401s without a session, the two token routes answer
without one, a junk token 404s, and the public recipe page's HTML carries no
email address.

### Google sign-in behind a proxy

That last one took one fix, and it will catch out the next person who deploys
behind a proxy. The callback URL is derived from the incoming request
(`getOAuthRedirectURL` → h3's `getRequestURL`). h3 honours
`x-forwarded-proto: https` but otherwise falls back to whether the *socket* is
encrypted — which behind nginx it isn't — so the app built
`http://host/auth/google` and Google rejected the flow with
`redirect_uri_mismatch`. The fix is `proxy_set_header X-Forwarded-Proto $scheme;`
in the nginx location block (README has the full snippet); confirmed working in
production. `NUXT_OAUTH_GOOGLE_REDIRECT_URL` pins the URL outright if you'd
rather not depend on a header.

Reproducing this without Google credentials is easy, and worth knowing for any
future proxy question: start the production build with dummy client id/secret
and read the `Location` header of `/auth/google` — the redirect leg never
contacts Google, so the derived `redirect_uri` is right there in the 302.

```bash
curl -sD - -o /dev/null -H 'Host: example.com' http://localhost:3000/auth/google | grep -i location
```

## Known gaps, if you're looking for work

- No service worker — the manifest makes it installable, not offline-capable.
- Friend requests are **polled**, not pushed: the prompt in the layout asks
  `/api/friends/pending` on load and every two minutes. Fine for a household;
  it is not a notification system, and there is no email.
- Nothing tells a friend that you *changed* what you share — the door simply
  closes. A note on their page would be kinder than a tab quietly disappearing.
- A friend's page shows their diary a day at a time with no summary; there is no
  way to compare two people's weeks side by side, which is the obvious next
  thing to want from a family tracker.
- Invite links can't be addressed to a person, so anyone who gets hold of one
  can use it, and now more than one person can use the *same* link. It expires
  in 30 days (`INVITE_TTL_DAYS`) and the inviter can cancel it, which is the
  whole mitigation.
- 34% of foods have no `serving_grams`; the portion picker falls back to 100 g.
- Water "undo" subtracts a preset amount rather than removing the last entry.
- No macro trends — Trends charts calories and weight only.
- The calorie target is set once and never revisited; nothing nudges you when
  your actual rate of loss diverges from the plan you stored.
- No meal copying or "log yesterday again".
- The ingredient parser gives a bare count ("2 large eggs", "1 garlic clove")
  0 g and a note, because there is no per-egg weight to look up. A small table
  of typical unit weights would resolve most of them.
- Volume of a non-liquid food converts at 1 ml = 1 g. Right for water, ~8% low
  for oil, ~45% high for flour. The portion label is stored alongside so the
  assumption is visible and one tap from being fixed, but a density table for
  the dozen things people actually measure by cup would be better.
- Nothing re-runs the matcher over old unresolved lines when the food library
  grows, and there is no "try again" button.
- The URL importer has no JavaScript engine, so a recipe rendered client-side
  is invisible to it. The paste tab is the fallback, but nothing tells the user
  that in so many words.
- A nested recipe is re-totalled through its ancestors on every edit, which is
  fine at household scale and is a full walk per mutation. If someone builds a
  hundred-recipe web it wants a dirty flag instead.
- A frozen meal keeps the name it was logged under, so renaming a recipe to fix
  a typo leaves the old spelling in the diary. Defensible — it is a record —
  but propagating a rename to that recipe's snapshots is a one-liner if it
  grates.
- A logged recipe's *breakdown* still reads its ingredient foods live, so
  editing a custom food changes what a past meal is shown to have been made of.
  The meal's own calorie figure is frozen and does not move. Same trade the app
  has always made for a plain custom food.
- A custom food that has been logged still can't be deleted (409). Archiving
  would be kinder. Recipes no longer have this problem — they are frozen when
  logged.
- `data/` is gitignored — the 79 MB database does not travel via git. A fresh
  clone must run `node scripts/import-off.mjs` (~2 min).
- `scripts/reset-user-data.mjs` strips personal data while keeping the food
  library, for handing over a clean database.
