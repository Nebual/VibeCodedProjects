Plan building a new Web App (Nuxt v4, Tailwindcss v4, DaisyUI, node 24, pnpm). Teams report stats for each match, for Both players in a match. They track whether the match won (for tracking league points (wins = 3, draw = 1, lose = 0)), touchdowns and casualties are done by each player in a match. We'll then score it over a whole league. Winner is who has most league points, if tie whoever has the most touchdowns, if tie whoever has the most casualties. One player in a match can log stats for both players in the match (or they might both enter separately) - they both have shared ownership over the match they're in. The league admin sets up the league, which is a series of rounds of matchups between pairs of players - so if there's 8 players, in round one you'd have #1 against #2, #3 against #4, #5 against #6, #7 against #8, and thats a first round of 4 matches. No auth initially, the initial page just shows 'League Admin' or a list of players in any league, and anyone can choose which to open with (which is then remembered in localStorage, but a logout button returns to that picker). On the page that players record stats for each match, include a link to https://bloodbowlbase.ru/bb2025/core_rules/#post-game-sequence .

Players (or the league admin) can set the date for a Match. There's a list of matches in a round, viewable by all players in the league, ordered by date. Lets have an api for external use, that allows increment/decrement/set the touchdowns for the current round, where 'current' is based on the date (assume for this endpoint only 1 match per day).

Let the admin enter stats for any match in the league. Write a script that imports the following league `<snippet>`

Rather than generating 1 round, lets generate all the rounds (before the semifinals), ensuring there's no conflicts where the same matchup happens twice. The number of rounds depends on the number of players (number - 1) so each player matches up against everyone else exactly once.

When selecting 'play as X' player, load their Matches

Allow a player to change their own name.

When entering scores, have big - and + buttons next to the number field. When updating the number of touchdowns, preselect whether that was a Win (for whom) or tie.

When viewing Standings, default to only showing complete rounds (its inaccurate showing a player with 3 games done as being higher than another who only did 2 so far). Have a toggle to show incomplete rounds.

When picking a player (or manage this league) on the front page, lets show them listed below the league name header, rather than to the right of it. Default to having the newest league expanded.

Mobile view needs some polish - the navbar is too wide (we can hide Standings since its on the league page). 'Report' button is being spread across 2 lines. The 'Your match' tag can be replaced by some floating position: absolute icon left of the card, to save space. On mobile, lets drop the padding/border around each Round card (just use a Round 1 header)

When reloading the /player/x page, it seems to redirect to the front page.

Admin view mobile needs some polish too, similar problems. Add UI (maybe to the bottom of the player page?) to rename yourself (unless I missed where the UI is?)

Use https://storage.googleapis.com/binderpos-event-images/b267128d-0a99-43c6-8bef-42696050792c-1745262141580.png (downloaded) as the icon instead of the blood drop

Let players rename themselves too (maybe in a Gear dropdown menu)

On the Standings page, TD and CAS don't appear to be working - I always see 0. Lets make the columns more than 1 letter - Win, Tie, Loss. Is that first column # of rounds played? Lets call it 'Rounds' and hide it if the 'show incomplete rounds' toggle is on.

Can we make the Standings table fit on mobile - mostly by reducing padding, and hide 'Loss' column on mobile

Naw flip that toggle - hide the Rounds if we're only showing complete onces (because everyone would have the same)
