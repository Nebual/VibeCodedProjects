The initial prompt that spawned this repo:


> Create a new Nuxt v4, Tailwindcss, Daisyui app using node v24 and pnpm.
> The app is part Find a Game, part Backlog for media consumption, and part personal reviews (like Goodreads).
> It tracks which media the user is consuming (and optionally with which other people, to help find a game together), it works for games, shows, movies, books, other.
> It could include some sort of 'last played' indicator to help sort and identify 'oh we should pick that up again before we totally forget'
> And it could have a Random button that highlights one of the items.
> The user can enter the last episode watched of a show, which is saved with the show and shown with it.
> A review can be left of a media, out of 5 stars and with a message (so I can write why X book changed my life, so when I go to recommend a book years later I can read my excited review and get excited all over again).
> Store data in yml files.
> Users can type a name to use, stored in localStorage. They can view their own media lists, and the lists of others who have tagged them in their lists (so if Nebual adds that he's playing Helldivers with @Bishop, Bishop can see Nebual's lists, but not edit them).
> show media I've been tagged in by others on the main Library view by default, with a 'Show tagged' checkbox
> - If Bishop tagged me in a list, we're friends, so I can see his whole list
>  Lets store media in separate files per-user, with a friends.yml listing who is tagged in whose (so we know which separate media yml's to lookup)
> - on dark mode, the cards blend in with the background, lets give them a bit more of a border
> - the search is good but lets also have a multi-dropdown of friends. When filtering by friends, sort by how many of those friends are tagged in each game (so a game with all selected friends tagged would show first, a game with only one of the friends tagged shows last)

> Add a 'Minimum 3' and 'Minimum 4' options when editing media that have at least 2 or 3 other people tagged in them (the 'Minimum 3' includes self). Also add 'Soloable' option when theres others tagged.
> When viewing the library with friends selected, respect the minimum 3/4 options (eg. if Bishop is selected, and Helldivers has Bishop and 5 other people, and 'Minimum 3' is on for Helldivers, then don't show it unless a 3rd Helldivers player is selected).
> The friends dropdown should get a 'Solo' option that filters only media marked Soloable or that don't have others tagged.
