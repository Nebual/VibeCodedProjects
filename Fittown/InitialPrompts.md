Create a new web app called NShoppingList, using Nuxt v4 with Tailwind v4 and DaisyUI. Use pnpm and have nvm set node 24.
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

