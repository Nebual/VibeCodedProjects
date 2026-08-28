Create a new web app called Fittown, using Nuxt v4 with Tailwind v4 and DaisyUI. Use pnpm and have nvm set node 24.
The web app is a calorie/nutrition/workout tracking app, similar to Chronometer or MyFitnessPal (I'm just making this for personal use, non-commercial). Mobile view is important, though also working on Desktop is useful.

It should have a Diary of food eaten today, water, and fitness.

Can we host Open Food Facts locally?

For display units, Canadians commonly use lb/ft for body measurements, and a mix of g/lb for food depending on the recipe. So lets have a setting for displaying Food measurements and Body measurements separately, and allow inputting data (in settings, diary, etc) with several unit options eg. specifying the Portion size in either (g, 100g, servings (123g), oz (28g), lb (454g), kg). When selecting any portion size other than g, display what that calculates out to (so 2 x oz, shows thats = 56g).

When entering a Goal Weight, switch from Maintain to Gain/Lose accordingly. Default to 0.5lb/week.

Allow editing the macro ratio in the Daily goals settings, and have the default be 25% protein, 45% carb, 30% fat.

When logging weight in the Diary, also allow logging other custom biometrics, such as bicep size. In the Trends charts, also chart custom biometrics.

When logging workouts, show the top 10 most recently used workouts for quick access.

When logging workouts, rather than having a large list at the start (though keep the search), lets have a series of card grids with icons that drill down into categores. Top level cards include Cardio, Gym, Household Activities, Outdoor Activities, Sports, Occupational Activities, Strength and Mobility. Activities may appear in multiple categories (eg. cycling is an outdoor and a cardio). Upon selecting an activity (if it makes sense) allow choosing an Effort Level (with explanations of what they mean - Light = Require some effort but not enough to speed up breathing, Moderate = Requires moderate effort. Speeds up heart rate and breathing but does not leave you out of breath. Hard = Requires vigorous effort. Gets the heart pounding and makes breathing very fast.), which changes the calories estimate. Research more types of activities and ideally find calorie estimate ranges to base these calorie counts on.

Lets create unit tests, using vitest, for the assertions you've been checking so far

Create a plan for adding Recipes, which are a mixture of foods with a name. You can customize the amount of each ingredient food in the recipe, edit the foods in a recipe, name the recipe, specify a final recipe weight, and specify how many servings it makes - which sets the serving size for that recipe when added to the diary.  When adding to diary, 'whole recipe' is another portion type, though the default type should be 1 serving. Don't show portion options involving grams if the recipe doesn't have a final weight.

To save vertical space, hide 'Nothing logged yet.' in the Diary.

As a joke, add a 'Poll: should I add in-app full screen ads for diamond rings?' to the bottom of the settings page. It has 'Yes' and 'No' buttons, and hitting either makes it look like the user hit 'Yes' and disables 'No'. This is merely a UI joke so it shouldn't save.

Tweaks: When you select a biometric field the box appears but doesn't focus the cursor. 
When viewing a recipe, move the 'In this portion' box lower below Edit/Add. Same for ingredients, move Nutrition to bottom of page.
Lets add a Quick Add button (small, to the right of + Add Food) that allows logging generic calories/macros. When quick adding, can select a Meal, optional name, calories, fat, carbs, protein, fibre, sugar alcohols. Entering macros when calories hasn't been entered, autocalculates calories (and indicates so).

Lets have the + Add Food button take up most of the width (though still left-align the text), with Quick Add on the right side of the area.

For the 'Add' food to meal page, rather than having a 'Frequent', 'Search', 'Recipes' tabs, lets instead show a single list of Frequent for this meal at the top, then Frequent/recent but not in this meal (so when adding a Lunch, breakfast items show below the lunch items), and then all recipes, and then search results. So when searching, if the search query matches any frequent/recipes, those'll show above raw search results.
Lets add a '+ Create a new Recipe' above 'Create a custom food'.


Lets add sharing functionality with friends. You can add a friend either by typing in their email (which they then have to accept a popup), or sending your friend an Invite link (where the friend then hits Accept on the link's page).

On the Friends tab, you can see your friends, clicking them shows their trends graphs and a list of their recipes, which can be viewed (but not edited directly). There's an 'Add recipe' and 'Log food' when looking at a friend's recipe, which copies it into your recipes. Friends recipes also show (below your own) when searching for foods.

Lets also allow Sharing a recipe via a link independent of the Friends system. Recipe links can be viewed without being logged in.

Lets also add a Sharing section to Settings, which lets you change whether Recipes, Food diary, Weight, Calories, and Exercise are shared with friends or not.

When showing search results for foods, generic foods that don't have serving suggestions are less useful - lets indicate 'no serving size' on them and adjust sorting so that, unless there's some other reason to prioritize them (eg. they're in Recent/Friends), search results with serving sizes show in the first 5 positions before then showing the generic option. Does that make sense, can I clarify anything?


Plan adding new ways to import Recipes. A simple one is a bulk entry, the user pastes or types in a list of
ingredients such as:
1/4c avocado oil
45g balsamic vinegar
pinch of salt
a lot of oregano
garlic powder

Foods without clear numeric amounts are interpreted as 0g for nutritional purposes, with a note/description added on the ingredient specifying the amount descriptor (so "salt" (pinch of), "oregano" (a lot of)) for the user to interpret. The list is parsed and ingredients added to a new recipe which the user can then review and customize.
Recipes should also get an Instructions text, so steps can be described.

Another import method is via url - the user pastes in a recipe url, such as https://www.loveandlemons.com/balsamic-vinaigrette/ , and we look for Ingredients and Instructions sections, along with any other details like Prep Time: 5 mins, Total Time: 5 mins, Serves 6 to 8, which can also be added to the instructions block, along with the original url added to the bottom of the instructions.
Ask me any clarifying questions.


Bug: in Quick add, if you start typing and then clear the calories, you cannot submit even if there's macros added. Lets allow that.
Lets add a 12oz / 350ml button to the add Water options.

Is there a better reference for default recommended water intake? Should it be based on gender/weight/activity level? Lets research it and then add it to the Calculate Calories button in settings, and also make that button Primary if the amount of calories are still set at the initial.

Add 'x' button to clear the food search bar.
A user made a recipe containing several items, one clearly had carbs, but the overall recipe shows 'Carbs: not recorded'. How might that happen? Was that because of a null in one of the ingredients?
Barcode scan isn't working in mobile firefox either - lets move to a camera (which'll probably need to ask permission)

I have a qwen3-VL model running in llama-server at 192.168.0.162:8191 (relative to this dev machine) that I use for OCR, can we use that to scan Recipes? It can probably feed into the existing recipe import flow. In production, it'll be at localhost:8191

Plan recipe improvements:
- changing a recipe should not affect previously logged uses of it
- it needs to be easier to make quick adjustments of recipes, for example a (4 eggs, 35g cheddar, 10g butter) omelette swapping to 3 eggs. I think it should be possible to make that adjustment as a one-off for just today, or to offer a button to Save it as a variant.
- variants of a recipe are linked together, so when viewing 1 you can navigate to another
- a recipe can have 'optional' ingredients, like suggesting 50g of bacon on top. It should be easy to toggle optionals in the recipe, where if off, it doesn't appear in the logged use in the diary. Choosing to skip an ingredient once in this way, is separate from removing it from the recipe permanently.
- allow reordering ingredients, so we can put Almond Flour next to regular Flour as an optional substitution
- Lets also allow recipes to include other recipes, so if I make a Salad Dressing recipe in bulk (6 servings) I can add 1 serving of it to my Salad recipe.

I'm interested in importing Branded Foods now, which I would want to prioritize slightly above OFF due to quality. We should also, when searching for items, show a pill indicating OFF or USDA-BF too. Deduping is a good idea, curious if there's a clear winner between USDA-BF vs OFF for a few of the same barcodes. Any other questions I can answer?
Did you say the same barcode pointed at multiple products? Would it be helpful to have the user specify their country (Canada or US) to help pick the right one?

Are there any indexes we should add to speed up the Add Food search?

Allow users to see custom foods from others. Lets show the user who created the custom food next to the pill, like the 'no serving size'

Allow marking a food (if its not USDA-FDN, and not a custom food by this user) as 'Report as Inaccurate' which hides it from display (except if its a custom food, its owner can always still see it). Lets move the Report as Inaccurate button to be at the bottom of the nutrition section, and make it btn-sm. Hide the helper text.

When creating custom food, allow scanning barcode to fill in that field. If the barcode already exists in the db, state that (as info) with links (open in new tab) to that food entry. The BarcodeScanner modal: replace the 'Look up' button text with 'Use' and hide the 'Create custom food' button when the modal is opened from the custom-food create page. When a food is marked inaccurate, it should still be able to be navigated to directly by url.

When switching portion type (eg. To grams) auto focus and select the amount so you don't have to delete 3 times to clear it.

When viewing a food or recipe, lets hide Vitamins, Minerals, and Other when they're 'not recorded'. Lets reorder macros to display as 'Fat', then 'Carbs', then Protein. Both in NutrientBreakdown and when adding custom foods.

Have the diary default to Yesterday between 12am and 3am. Also when logging a food, assume its for yesterday during that late-night period. In Diary, when showing 'Yesterday' or 'Today' in the day switcher, include (Mon) or (Tue) as appropriate.

# Nutrition Facts OCR

Lets add Nutrition Facts label scanning for quickly adding a Custom Food. It'll use the same OCR api as the recipe scanner, and prefill the form. For a sample image see @file:PXL_20260820_075057303.jpg , which shows a Canadian Nutrition Facts label, top line 'Nutrition Facts'. If the label contains extra measurements that the Custom Food page doesn't normally show (eg. Calcium or Iron), show extra field inputs and prefill them too. The label may have 'English / French' fields (like 'Fat / Lipides'), disregard the French part. It may have % Daily value's, ignore those.

Details to pull from this photo:
Per 3 bars (45g)
Calories 210
Fat 15g
Saturated 14g
Trans 0g
Carbohydrate 24g
Fibre 3g
Sugars 9g
Protein 2g
Cholesterol 0mg
Sodium 0mg
Potassium 150mg
Calcium 0mg
Iron 1.75mg

The Share recipe button should immediately write to clipboard.  
Let's allow clicking the serving amount on the diary to switch to an inline input, similar to in recipes.

The Trends graph doesn't account for exercise, it should chart net calories. Also let's include on the calorie chart, in a separate overlaid colour, the calories burned.

On the diary page, add a new Reminders section, below the Fitness card. When a new reminder is added, it presents as a todo checkbox, that when checked the text fades a little. Later days after its first created day will also show the checkbox, until the checkbox is removed (with a confirmation), at which point that + future days stop showing it, but past days still will. Examples include Vitamin D, Meds, etc.

Lets expand the feature to allow for weekly (on a Friday) or monthly (on a day, defaulting to today's day of month) or 'every Monday and Friday' or 'every 5 weeks'. Adjusting the frequency affects after that day, the past is left as it was. So I might have a Garbage reminder repeating every other Thursday, have that for months, and then change it to be on every other Friday from that point onward (but the past stays on Thursdays). For UI, lets replace the Trash button with a Gear dropdown containing Edit Recurrence, Delete Today's, Delete + Future. Edit recurrence opens a modal allowing configuring the future scheduling.

On the Settings page, lets allow customizing what cards appear on the Diary page: Calorie / Macros Summary, Breakfast, Lunch, Dinner, Snacks, Water, Fitness, Reminders, Body Measurements, Full Nutrition. Lets have it inside a collapsible section to save space initially. Default to all on, but if the user disables some, they hide from the Diary view.

Lets improve the flow for adding Recipe variations. Lets make the placeholder text when naming a new variant default to the existing recipe name with ' 2026-08-27' (current date) appended - after removing any existing number/dashes from the end. The default name used when hitting Create with an unfilled input should match that new placeholder.

Lets add a Setting for 'Portion Type Default', the default is per serving as it has been so far, other options include g and 100g  
On the settings page, I get a 400 when trying to save with the Diary Cards hidden section collapsed. It seems to default to sending '["body"]' instead of an actual array. Lets just not send it with the page-wide post since each Diary Cards toggle change immediately saves anyway.  
When first focusing a portion amount input, lets cursor select the current value, so the user can just type overtop of it to replace.


