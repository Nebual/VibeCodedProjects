# The initial prompt that spawned this repo:

Create a new web app called NShoppingList, using Nuxt v4 with Tailwind v4 and DaisyUI. Use pnpm and have nvm set node 24.

The primary view a list of grocery items to buy. The list is sorted with things to buy at the top, already bought slightly faded below, sorted by when it was most recently bought. Marking an item as bought does not immediately resort the list, but waits until 5 seconds of inactivity before sorting (to avoid disrupting the user).

There's a search that can be used to add new items to the list.

Each item tracks the timestamp it was added as to be Bought, and also when it was last marked bought (not changing the last marked as Bought if its < 20 minutes since it was added to the list -- that would be correcting a mistake, not actually buying).

Its possible to remove items from the list, by clicking a dropdown menu on each item that has a Delete button, with a confirmation, visible once they're marked Bought.

Changes to the list are synced with a server after 3 seconds of inactivity. The server should store lists as JSON files. Visiting /l/{jsonFileName} should load that file. Multiple users/devices can load the same list at once, and changes to one should sync to the others, so ideally most actions (adding new, marking as bought/to-buy) should sync just their changes to the server, rather than overwriting the whole list, to avoid clobbering eachother's changes.

In a small menu there's a New List button that opens the newly generated page, and a Share button that opens a Modal telling them "You can share this list with anyone by sending them the link. I hope you weren't expecting social media tie-ins like a one-click post my grocery list to instagram button!".

Additions:
- add a hr between the to-buy and the rest of the list
- lets make it denser - reduce padding on the list items, make the date added even smaller and slightly fainter
- remove the text 'not needed'
- the server should make a backup of a list, at most once a day per list, before the first write action of that day. Backups can be named `listname.backup-2026-07-30`, they should be viewable like other lists but block edits serverside

Lets add a bulk add textarea. Add a bulk button to the right of the searchbox (when its empty). Clicking it shows a textarea where we can paste in a list of additions, line or comma separated, such as:
```
the Breton crackers
canned salmon
pecans
eggs x2
tomato sauce can
canned corn reserves are low
any fun fruit
black beans totally empty I think
```

Submitting this bulk list should attempt to match items -- "pecan" should match "pecans" and vice versa (those are only 1 letter off), "eggs x2" should match a shopping list item of "eggs", "the Breton crackers" should match "Breton crackers", "black beans totally empty I think" should match "black beans", etc.  It is ok if some items don't get matched up.

Upon submit, hide the textarea and show a summary of how each submitted item was matched - if successfully matched with an existing item, mark the existing 'To buy' and show that the submitted item matched with it (allowing the user to reject the match, undoing the add to To Buy if the bulk action is what marked it as To Buy). 

If no clear match, let the user edit the entry (which might then match) or click a '+' button to add a new entry (to To Buy)

don't show "undo" if it didn't change anything



"pecans" matched with "pears" - thats too different and shouldn't match

In the bulk view, the user should be able to disagree with a non-exact match, and type in an alternative

Its also a bit visually confusing to read what matched with what - perhaps have the bulk item on the left, and the match on the right (with buttons to accept/add to the furthest right).

New feature: tagging grocery items with a soft colour (to organize by area of the store, eg. all produce gets green colour and listed together, all bread products get yellow, frozen gets light blue etc) and optionally with a symbol (star, i-mdi-store-remove for non-Costco). These tags will usually be added in bulk, so lets have a flow where we can bulk apply a colour/tag by selecting multiple items and then applying a tag to them. Lets also allow setting tags in the Bulk Add review UI.

Also, when processing OCR images of text, lets interpret "+" and "-" in between words as meaning "two separate items", eg.
```
- crackers    # just means 'crackers'
- tuna - nutritional yeast + garlic     # means 3 separate items
```

