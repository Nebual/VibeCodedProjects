Create a new web app called NShoppingList, using Nuxt v4 with Tailwind v4 and DaisyUI. Use pnpm and have nvm set node 24.
The web app is a calorie/nutrition/workout tracking app, similar to Chronometer or MyFitnessPal (I'm just making this for personal use, non-commercial). Mobile view is important, though also working on Desktop is useful.

It should have a Diary of food eaten today, water, and fitness.

Can we host Open Food Facts locally?

For display units, Canadians commonly use lb/ft for body measurements, and a mix of g/lb for food depending on the recipe. So lets have a setting for displaying Food measurements and Body measurements separately, and allow inputting data (in settings, diary, etc) with several unit options eg. specifying the Portion size in either (g, 100g, servings (123g), oz (28g), lb (454g), kg). When selecting any portion size other than g, display what that calculates out to (so 2 x oz, shows thats = 56g).

When entering a Goal Weight, switch from Maintain to Gain/Lose accordingly. Default to 0.5lb/week.

Allow editing the macro ratio in the Daily goals settings, and have the default be 25% protein, 45% carb, 30% fat.

When logging weight in the Diary, also allow logging other custom biometrics, such as bicep size.

When logging workouts, rather than having a large list at the start (though keep the search), lets have a series of card grids with icons that drill down into categores. Top level cards include Cardio, Gym, Household Activities, Outdoor Activities, Sports, Occupational Activities, Strength and Mobility. Activities may appear in multiple categories (eg. cycling is an outdoor and a cardio). Upon selecting an activity (if it makes sense) allow choosing an Effort Level (with explanations of what they mean - Light = Require some effort but not enough to speed up breathing, Moderate = Requires moderate effort. Speeds up heart rate and breathing but does not leave you out of breath. Hard = Requires vigorous effort. Gets the heart pounding and makes breathing very fast.), which changes the calories estimate. Research more types of activities and ideally find calorie estimate ranges to base these calorie counts on.

Lets create unit tests, using vitest, for the assertions you've been checking so far
