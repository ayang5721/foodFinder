# Local Grocery Macro Meal Planner

Offline-first prototype for the Codex build spec in
`local_grocery_macro_meal_planner_codex_spec.md`.

## Run

Open `index.html` in a browser, or serve the directory with any static server:

```bash
python3 -m http.server 5173
```

Then visit `http://localhost:5173`.

## What is implemented

- Adult macro target calculator using Mifflin-St Jeor, activity multipliers, goal adjustments, and guardrail warnings.
- Profile, preference, location, radius, and store selection UI.
- Mock Places provider returning normalized grocery stores.
- Mock inventory provider using staple grocery search terms.
- Nutrition provider interface with estimated offline fallback data.
- Deterministic meal templates, portion tuning, plan scoring, and three plan options.
- Shopping list grouped by store with estimated cost, availability labels, and substitutions.
- Health disclaimer and explicit "availability not verified" notes for fallback store data.

## Provider extension points

`src/providers.js` includes offline mock providers and stubs for:

- `GooglePlacesProvider`
- `KrogerInventoryProvider`
- `InstacartInventoryProvider`
- `CompositeNutritionProvider`

The production version should move API calls behind server routes so API keys are not exposed in the browser.
