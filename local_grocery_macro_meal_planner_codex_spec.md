# Codex Build Spec: Local Grocery Macro Meal Planner

## 0) Product summary

Build a web app that takes a user's body stats, goals, preferences, and location, finds nearby grocery stores, attempts to retrieve local store product availability/pricing through official APIs, then generates meal-prep options that hit the user's calories/macros. The app outputs:

1. Daily calorie and macro targets.
2. 3-7 day meal plan options.
3. Meal-prep instructions.
4. Shopping list grouped by store.
5. Item substitutions when a product is unavailable.
6. Estimated price and macro totals per option.

The app should be built as a modular prototype first, with provider adapters so inventory and nutrition APIs can be swapped later.

---

## 1) Important constraints and assumptions

### 1.1 Do not use OSM API v0.6 for this app
OSM API v0.6 is for editing OpenStreetMap data, not nearby POI search. For nearby grocery stores, use Google Places API or an OSM Overpass/Nominatim fallback.

### 1.2 Google Places behavior
A "find grocery stores near me" request can be one Places API call if the app already has the user's latitude/longitude. If the user enters a typed address/city, first geocode it, then perform a Places search.

Use Google Places API Nearby Search or Text Search.

Nearby Search endpoint:

```http
POST https://places.googleapis.com/v1/places:searchNearby
```

Recommended field mask:

```txt
places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.websiteUri,navigationLinks
```

For MVP, use a smaller field mask to keep cost down:

```txt
places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType
```

Text Search endpoint:

```http
POST https://places.googleapis.com/v1/places:searchText
```

Use Text Search when the user gives free-text such as "Asian grocery", "Trader Joe's", "cheap groceries", or "groceries near me".

### 1.3 Local stock is the hardest part
Exact local grocery inventory is not universally available through public APIs. Build a provider system:

1. **Instacart Developer Platform / Instacart APIs**
   - Best broad solution if access is approved.
   - Can support item availability, pricing, smart shopping lists, nearby retailers, and grocery fulfillment.
   - Treat this as the preferred production provider.

2. **Kroger Public APIs**
   - Good for Kroger-owned chains.
   - Use Locations API to find a Kroger location near the user.
   - Use Products API with `locationId` to search product catalog and local availability signals.
   - Useful for MVP if app is launched in regions with Kroger-owned stores.

3. **Retailer-specific official APIs**
   - Add adapters only when official docs/terms allow it.
   - Walmart Marketplace Inventory API is seller/marketplace oriented, not a general consumer local-store stock API. Do not assume it can check every local Walmart shelf unless the app has appropriate partner access.

4. **Fallback mode**
   - If exact local stock is unavailable, plan meals using common grocery items and pair them with nearby stores as likely purchase locations.
   - Clearly label this as "availability not verified".
   - Offer substitutions.

### 1.4 Do not scrape protected retailer websites by default
Do not bypass login, anti-bot protections, rate limits, or terms of service. If a store has public pages that permit indexing, a separate compliance review is needed before scraping. For MVP, stick to official APIs and user-provided CSV/manual inventory.

### 1.5 Health and safety
This app estimates nutrition targets. It must not claim to diagnose, treat, or provide medical advice. Add disclaimers and require the user to confirm they are not using the app for a medical diet unless supervised by a professional.

---

## 2) Recommended stack

Use this unless the repo already has a stack:

- **Frontend:** Next.js App Router + TypeScript + Tailwind + shadcn/ui
- **Backend:** Next.js API routes or separate FastAPI service
- **Database:** Postgres + Prisma
- **Validation:** Zod
- **Caching:** Redis or Vercel KV
- **Jobs:** Inngest / BullMQ for background inventory refreshes
- **LLM meal generation:** OpenAI-compatible provider through a `MealGenerationProvider` interface
- **Optimization:** Start with deterministic heuristic scoring; later add linear programming with OR-Tools or Python backend
- **Testing:** Vitest for TS, Playwright for E2E, pytest if Python optimization service is added

---

## 3) MVP user flow

### Step 1: User profile form

Collect:

```ts
type UserProfileInput = {
  age: number;
  biologicalSex: "male" | "female" | "unspecified"; // only used for BMR equation; allow override
  heightCm: number;
  weightKg: number;
  activityLevel:
    | "sedentary"
    | "light"
    | "moderate"
    | "very_active"
    | "athlete";
  goal: "cut" | "maintain" | "lean_bulk" | "bulk";
  targetRate?: "slow" | "standard" | "aggressive";
  mealsPerDay: number; // default 3 or 4
  planningDays: number; // default 3, allow 1-7
  dietStyle?: "omnivore" | "vegetarian" | "vegan" | "pescatarian";
  allergies: string[];
  avoidFoods: string[];
  preferredFoods: string[];
  cookingSkill: "no_cook" | "basic" | "intermediate" | "advanced";
  equipment: Array<
    | "microwave"
    | "stove"
    | "oven"
    | "air_fryer"
    | "rice_cooker"
    | "slow_cooker"
    | "blender"
  >;
  budgetLevel: "lowest_cost" | "balanced" | "premium";
};
```

Also allow advanced overrides:

```ts
type MacroOverrideInput = {
  calorieTargetOverride?: number;
  proteinGOverride?: number;
  fatGOverride?: number;
  carbGOverride?: number;
};
```

### Step 2: Location input

Support:

```ts
type LocationInput =
  | { kind: "gps"; lat: number; lng: number }
  | { kind: "text"; query: string };
```

If `kind = text`, geocode before searching. If `kind = gps`, use it directly.

### Step 3: Find nearby grocery stores

Search radius default: 5 miles / 8 km. Let user change it.

Return normalized stores:

```ts
type GroceryStore = {
  provider: "google_places" | "osm" | "kroger" | "instacart" | "manual";
  providerPlaceId: string;
  name: string;
  formattedAddress?: string;
  lat: number;
  lng: number;
  placeTypes: string[];
  websiteUrl?: string;
  phone?: string;
  chain?: string;
  distanceMiles?: number;
  supportsInventoryLookup: boolean;
  inventoryProvider?: "instacart" | "kroger" | "manual" | "none";
};
```

UI should show store cards with:

- Store name
- Address
- Distance
- Inventory support status:
  - "Stock available through API"
  - "Partial catalog available"
  - "Availability not verified"

### Step 4: Retrieve store inventory / products

Normalize all inventory providers into one shape:

```ts
type GroceryProduct = {
  provider: "instacart" | "kroger" | "manual" | "mock";
  providerProductId: string;
  storeId: string;
  upc?: string;
  name: string;
  brand?: string;
  category?: string;
  imageUrl?: string;
  sizeText?: string; // "32 oz", "1 lb", etc.
  packageQuantity?: number;
  priceCents?: number;
  priceCurrency?: "USD";
  available: boolean | "unknown";
  fulfillment?: {
    pickup?: boolean;
    delivery?: boolean;
    inStore?: boolean;
  };
  sourceUrl?: string;
};
```

For MVP, query the product provider using a canonical list of staple search terms rather than trying every possible recipe item.

Example staple queries:

```txt
chicken breast
ground turkey
eggs
greek yogurt
cottage cheese
milk
tofu
salmon
tuna
rice
potatoes
oats
whole wheat bread
tortillas
pasta
beans
lentils
broccoli
spinach
bananas
berries
olive oil
avocado
peanut butter
protein powder
```

Provider behavior:

- Cache product results by `(provider, storeId, searchTerm)` for 6-24 hours.
- Do not refresh on every keystroke.
- Track API call counts.

### Step 5: Attach nutrition data

Create a nutrition resolver that tries sources in this order:

1. If product has UPC/barcode, search Open Food Facts by barcode.
2. If product has UPC or branded name, search USDA FoodData Central branded foods.
3. If generic ingredient, search USDA FoodData Central foundation/SR legacy data.
4. Optional paid/commercial fallback: Edamam Food Database / Nutrition Analysis API.
5. If no match, ask user to confirm or use a conservative generic estimate.

Normalized nutrition:

```ts
type NutritionPer100g = {
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG?: number;
  sugarG?: number;
  sodiumMg?: number;
};

type NutritionResolvedFood = {
  productId?: string;
  ingredientName: string;
  matchedSource:
    | "usda_fdc"
    | "open_food_facts"
    | "edamam"
    | "manual"
    | "estimated";
  externalFoodId?: string;
  confidence: "high" | "medium" | "low";
  per100g: NutritionPer100g;
  servingSizeG?: number;
  notes?: string;
};
```

---

## 4) Macro target logic

### 4.1 BMR / RMR

Use Mifflin-St Jeor by default. Allow the user to override calories.

```ts
function calculateBmrMifflinStJeor(input: {
  biologicalSex: "male" | "female" | "unspecified";
  weightKg: number;
  heightCm: number;
  age: number;
}): number {
  const base = 10 * input.weightKg + 6.25 * input.heightCm - 5 * input.age;
  if (input.biologicalSex === "male") return base + 5;
  if (input.biologicalSex === "female") return base - 161;
  return base - 78; // midpoint fallback; encourage user override
}
```

### 4.2 Activity multiplier

```ts
const ACTIVITY_MULTIPLIER = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  very_active: 1.725,
  athlete: 1.9,
} as const;
```

### 4.3 Goal adjustment

```ts
const GOAL_CALORIE_ADJUSTMENT = {
  cut: {
    slow: -250,
    standard: -500,
    aggressive: -750,
  },
  maintain: {
    standard: 0,
  },
  lean_bulk: {
    slow: 150,
    standard: 250,
    aggressive: 350,
  },
  bulk: {
    slow: 250,
    standard: 400,
    aggressive: 500,
  },
} as const;
```

Guardrails:

- Avoid recommending less than 1,200 kcal/day for most adult women or 1,500 kcal/day for most adult men unless the user explicitly overrides and a medical disclaimer is shown.
- Do not support minors in MVP without separate pediatric logic.
- For aggressive cut, warn about energy, adherence, and health risks.

### 4.4 Protein, fat, carbs

Default protein:

```ts
function proteinTargetG(weightKg: number, goal: string): number {
  if (goal === "cut") return Math.round(weightKg * 2.0);
  if (goal === "lean_bulk" || goal === "bulk") return Math.round(weightKg * 1.8);
  return Math.round(weightKg * 1.6);
}
```

Default fat:

```ts
function fatTargetG(calorieTarget: number): number {
  return Math.round((calorieTarget * 0.25) / 9);
}
```

Default carbs:

```ts
function carbTargetG(calorieTarget: number, proteinG: number, fatG: number): number {
  return Math.round((calorieTarget - proteinG * 4 - fatG * 9) / 4);
}
```

Return:

```ts
type MacroTargets = {
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberGMin?: number;
};
```

---

## 5) Meal planning algorithm

### 5.1 MVP deterministic approach

Do not rely only on an LLM. Use deterministic constraints first, then optionally ask an LLM to make the plan taste better.

Pipeline:

```txt
User profile
→ Macro target
→ Nearby stores
→ Available products
→ Nutrition matching
→ Ingredient candidate pool
→ Meal templates
→ Portion solver
→ Meal plan scorer
→ LLM polish / variation generation
→ Shopping list
```

### 5.2 Meal templates

Use templates with slots. Example:

```ts
type MealTemplate = {
  id: string;
  name: string;
  mealType: "breakfast" | "lunch" | "dinner" | "snack";
  tags: string[];
  slots: Array<{
    slotName: string;
    allowedCategories: string[];
    minGrams: number;
    maxGrams: number;
    defaultGrams: number;
  }>;
};
```

Example templates:

```ts
const MEAL_TEMPLATES: MealTemplate[] = [
  {
    id: "protein_oats",
    name: "Protein oats bowl",
    mealType: "breakfast",
    tags: ["cheap", "quick", "high_protein"],
    slots: [
      { slotName: "oats", allowedCategories: ["oats"], minGrams: 40, maxGrams: 100, defaultGrams: 60 },
      { slotName: "protein", allowedCategories: ["greek_yogurt", "protein_powder", "milk"], minGrams: 20, maxGrams: 250, defaultGrams: 170 },
      { slotName: "fruit", allowedCategories: ["banana", "berries"], minGrams: 50, maxGrams: 200, defaultGrams: 100 },
      { slotName: "fat", allowedCategories: ["peanut_butter", "nuts"], minGrams: 0, maxGrams: 40, defaultGrams: 16 }
    ]
  },
  {
    id: "rice_bowl",
    name: "Lean protein rice bowl",
    mealType: "lunch",
    tags: ["meal_prep", "balanced"],
    slots: [
      { slotName: "protein", allowedCategories: ["chicken", "turkey", "tofu", "salmon"], minGrams: 100, maxGrams: 250, defaultGrams: 170 },
      { slotName: "carb", allowedCategories: ["rice", "potatoes", "tortillas"], minGrams: 80, maxGrams: 350, defaultGrams: 200 },
      { slotName: "vegetable", allowedCategories: ["broccoli", "spinach", "mixed_vegetables"], minGrams: 100, maxGrams: 300, defaultGrams: 150 },
      { slotName: "fat", allowedCategories: ["olive_oil", "avocado"], minGrams: 0, maxGrams: 35, defaultGrams: 10 }
    ]
  }
];
```

### 5.3 Portion solver

MVP solver:

1. Generate candidate meals from templates and available products.
2. Start with default grams.
3. Calculate meal macros.
4. Adjust portions:
   - Increase/decrease protein slot to hit protein.
   - Increase/decrease carb slot to hit calories/carbs.
   - Increase/decrease fat slot to hit calories/fat.
5. Reject meals that violate allergies/preferences.
6. Build daily plans from meals.
7. Score daily plans.

Scoring function:

```ts
type PlanScoreBreakdown = {
  macroAccuracy: number; // 0-100
  priceScore: number; // 0-100
  varietyScore: number; // 0-100
  prepEaseScore: number; // 0-100
  availabilityScore: number; // 0-100
  preferenceScore: number; // 0-100
  totalScore: number;
};
```

Weighting:

```ts
const SCORE_WEIGHTS = {
  macroAccuracy: 0.35,
  availabilityScore: 0.2,
  priceScore: 0.15,
  preferenceScore: 0.15,
  prepEaseScore: 0.1,
  varietyScore: 0.05,
};
```

### 5.4 Plan options

Return at least 3 options:

1. **Cheapest**: lowest estimated cost, fewer ingredients, repeat meals allowed.
2. **High-protein / fitness**: strongest macro match, high satiety.
3. **Variety**: more diverse meals and flavors, may cost more.

Optional:

4. **No-cook / dorm friendly**
5. **Vegetarian**
6. **Low-prep under 30 minutes**

---

## 6) Shopping list generation

Combine ingredient quantities across meals.

```ts
type ShoppingListItem = {
  normalizedIngredient: string;
  productName?: string;
  storeId: string;
  storeName: string;
  quantityNeededG?: number;
  quantityNeededText: string;
  packageCount?: number;
  estimatedCostCents?: number;
  available: boolean | "unknown";
  substitutes: Array<{
    productId?: string;
    name: string;
    reason: string;
  }>;
};
```

Shopping list output should be grouped:

```txt
Store: Ralphs — 123 Main St
- Chicken breast, ~2.5 lb, estimated $13.50
- Jasmine rice, 5 lb bag, estimated $6.99
- Broccoli, 2 lb, estimated $4.00

Store: Trader Joe's — 456 Oak Ave
- Greek yogurt, 32 oz, estimated $5.49
```

If exact local stock is not available:

```txt
Availability note: this store was found nearby, but exact shelf availability was not verified. Items are common grocery staples and should be checked in-store or through the store's website/app.
```

---

## 7) LLM usage

Use LLMs only after deterministic nutrition calculations.

Good LLM tasks:

- Generate meal names and readable summaries.
- Suggest flavor variations using the same macro-friendly base.
- Generate cooking instructions.
- Explain tradeoffs between meal plan options.
- Convert raw plan data into a friendly UI summary.

Bad LLM tasks:

- Guess exact nutrition from scratch.
- Guess exact store inventory.
- Make unsupported medical claims.
- Ignore allergies or dietary restrictions.

LLM prompt skeleton:

```txt
You are generating a readable meal-prep plan from structured nutrition and inventory data.

Rules:
- Do not change the ingredient quantities unless explicitly allowed.
- Do not invent availability or prices.
- Do not claim medical benefits.
- Respect allergies and avoidFoods exactly.
- If stock is unknown, label it as unknown.
- Keep instructions practical for the user's cooking equipment.

Input JSON:
{{structuredPlanJson}}

Return JSON:
{
  "summary": "...",
  "meals": [
    {
      "name": "...",
      "prepInstructions": ["..."],
      "storageNotes": "...",
      "tasteVariations": ["..."]
    }
  ],
  "warnings": ["..."]
}
```

Validate LLM JSON with Zod. If invalid, retry once; otherwise fall back to deterministic copy.

---

## 8) API/provider interfaces

### 8.1 Places provider

```ts
export interface PlacesProvider {
  searchGroceryStores(input: {
    lat: number;
    lng: number;
    radiusMeters: number;
    query?: string;
    maxResults?: number;
  }): Promise<GroceryStore[]>;
}
```

Implement:

- `GooglePlacesProvider`
- `OsmPlacesProvider` fallback

### 8.2 Inventory provider

```ts
export interface InventoryProvider {
  supportsStore(store: GroceryStore): boolean;

  searchProducts(input: {
    store: GroceryStore;
    query: string;
    limit?: number;
  }): Promise<GroceryProduct[]>;
}
```

Implement:

- `KrogerInventoryProvider`
- `InstacartInventoryProvider` stub/interface
- `ManualInventoryProvider`
- `MockInventoryProvider` for local dev

### 8.3 Nutrition provider

```ts
export interface NutritionProvider {
  resolveNutrition(input: {
    product?: GroceryProduct;
    ingredientName: string;
    upc?: string;
  }): Promise<NutritionResolvedFood>;
}
```

Implement:

- `UsdaFdcNutritionProvider`
- `OpenFoodFactsNutritionProvider`
- `EdamamNutritionProvider` optional
- `CompositeNutritionProvider`

### 8.4 Meal planner

```ts
export interface MealPlanner {
  generatePlans(input: {
    userProfile: UserProfileInput;
    macroTargets: MacroTargets;
    stores: GroceryStore[];
    products: GroceryProduct[];
    nutrition: NutritionResolvedFood[];
    constraints: {
      maxBudgetCents?: number;
      mealsPerDay: number;
      planningDays: number;
      allergies: string[];
      avoidFoods: string[];
      dietStyle?: string;
    };
  }): Promise<MealPlanOption[]>;
}
```

---

## 9) Database schema

Use Prisma. Suggested models:

```prisma
model UserProfile {
  id              String   @id @default(cuid())
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  age             Int
  biologicalSex   String
  heightCm        Float
  weightKg        Float
  activityLevel   String
  goal            String
  dietStyle       String?
  allergiesJson   Json
  avoidFoodsJson  Json
  preferencesJson Json
}

model Store {
  id                    String   @id @default(cuid())
  provider              String
  providerPlaceId       String
  name                  String
  formattedAddress      String?
  lat                   Float
  lng                   Float
  chain                 String?
  supportsInventoryLookup Boolean @default(false)
  inventoryProvider     String?
  createdAt             DateTime @default(now())

  @@unique([provider, providerPlaceId])
}

model ProductCache {
  id                String   @id @default(cuid())
  provider          String
  providerProductId String
  storeId           String
  query             String
  productJson       Json
  fetchedAt         DateTime @default(now())

  @@index([provider, storeId, query])
}

model NutritionCache {
  id              String   @id @default(cuid())
  key             String   @unique
  source          String
  confidence      String
  nutritionJson   Json
  fetchedAt       DateTime @default(now())
}

model MealPlan {
  id              String   @id @default(cuid())
  userProfileId   String
  macroTargetsJson Json
  optionsJson     Json
  createdAt       DateTime @default(now())
}
```

---

## 10) API routes

### `POST /api/profile/macro-targets`

Input: `UserProfileInput + MacroOverrideInput`

Output:

```ts
{
  bmr: number;
  tdee: number;
  targets: MacroTargets;
  warnings: string[];
}
```

### `POST /api/stores/search`

Input:

```ts
{
  location: LocationInput;
  radiusMeters: number;
  query?: string;
}
```

Output:

```ts
{
  stores: GroceryStore[];
}
```

### `POST /api/inventory/search`

Input:

```ts
{
  storeIds: string[];
  queries: string[];
}
```

Output:

```ts
{
  productsByStore: Record<string, GroceryProduct[]>;
  warnings: string[];
}
```

### `POST /api/meal-plans/generate`

Input:

```ts
{
  userProfile: UserProfileInput;
  macroOverrides?: MacroOverrideInput;
  location: LocationInput;
  radiusMeters?: number;
  selectedStoreIds?: string[];
}
```

Output:

```ts
{
  macroTargets: MacroTargets;
  stores: GroceryStore[];
  options: MealPlanOption[];
  shoppingLists: ShoppingListItem[][];
  warnings: string[];
}
```

---

## 11) Frontend pages

### `/`
Landing page:
- Explain what the app does.
- CTA: "Build my grocery meal plan".

### `/plan/new`
Wizard:

1. Body stats and goal.
2. Food preferences/restrictions.
3. Location and radius.
4. Choose nearby stores.
5. Generate plans.

### `/plan/[id]`
Results page:

- Macro target card.
- Tabs:
  - Cheapest
  - Best macro match
  - Most variety
- For each plan:
  - Daily summary calories/protein/carbs/fat.
  - Meal cards.
  - Prep instructions.
  - Shopping list grouped by store.
  - Availability warnings.
  - Estimated cost.
  - "Regenerate with more variety" button.
  - "Swap ingredient" button.

---

## 12) Environment variables

```bash
# Places
GOOGLE_MAPS_API_KEY=

# Kroger
KROGER_CLIENT_ID=
KROGER_CLIENT_SECRET=

# Instacart, if approved
INSTACART_API_KEY=
INSTACART_BASE_URL=

# Nutrition
USDA_FDC_API_KEY=
EDAMAM_APP_ID=
EDAMAM_APP_KEY=

# Infra
DATABASE_URL=
REDIS_URL=

# LLM
OPENAI_API_KEY=
MEAL_LLM_MODEL=
```

---

## 13) Implementation plan for Codex

### Phase 1: Offline prototype
- Create Next.js app.
- Build profile form.
- Implement macro calculator.
- Add mock store search data.
- Add mock inventory data.
- Add USDA/OpenFoodFacts nutrition resolver interface with mock fallback.
- Generate meal plans from templates.
- Render shopping list.

### Phase 2: Google Places
- Add `GooglePlacesProvider`.
- Support GPS and typed location.
- For typed location, geocode or use Text Search with location bias.
- Store normalized grocery stores in DB.
- Add caching.

### Phase 3: Kroger inventory
- Add OAuth service-to-service token retrieval.
- Add Kroger Locations API integration.
- Match Google Places stores to Kroger locations by name/distance.
- Use Kroger Products API with `locationId`.
- Normalize product price, size, fulfillment availability, and UPC if present.

### Phase 4: Nutrition providers
- Implement USDA FoodData Central provider.
- Implement OpenFoodFacts provider for UPC/barcode lookup.
- Add confidence scoring.
- Cache resolved nutrition.

### Phase 5: Better planning
- Add portion solver.
- Add scoring.
- Add 3 plan modes: cheapest, best macros, variety.
- Add substitutions.
- Add budget constraints.

### Phase 6: LLM polish
- Generate human-readable summaries from structured plans.
- Validate output.
- Preserve deterministic macros.

### Phase 7: Production hardening
- Rate limiting.
- Error logging.
- Cost tracking per provider.
- Provider health checks.
- Privacy policy and nutrition disclaimer.
- Unit and E2E tests.

---

## 14) Matching stores to inventory providers

When Google Places returns nearby stores, determine inventory lookup support:

```ts
function detectInventoryProvider(store: GroceryStore): GroceryStore {
  const name = store.name.toLowerCase();

  const krogerChains = [
    "kroger",
    "ralphs",
    "fred meyer",
    "qfc",
    "fry's",
    "king soopers",
    "smith's",
    "dillons",
    "food 4 less",
    "harris teeter",
    "pick 'n save",
    "metro market",
    "mariano's"
  ];

  if (krogerChains.some(chain => name.includes(chain))) {
    return {
      ...store,
      supportsInventoryLookup: true,
      inventoryProvider: "kroger",
    };
  }

  // Instacart support depends on API access and retailer coverage.
  // If Instacart API returns retailer availability for this location, set provider to instacart.
  return {
    ...store,
    supportsInventoryLookup: false,
    inventoryProvider: "none",
  };
}
```

Better version:
- Do not rely only on name matching.
- Use provider retailer IDs when available.
- Match by coordinates, chain name, address, and phone.

---

## 15) MealPlanOption schema

```ts
type MealPlanOption = {
  id: string;
  label: "cheapest" | "best_macros" | "most_variety" | "custom";
  title: string;
  summary: string;
  days: Array<{
    dayIndex: number;
    meals: Array<{
      mealType: "breakfast" | "lunch" | "dinner" | "snack";
      name: string;
      ingredients: Array<{
        productId?: string;
        ingredientName: string;
        quantityG: number;
        quantityText: string;
        caloriesKcal: number;
        proteinG: number;
        carbsG: number;
        fatG: number;
        storeId?: string;
        availability: boolean | "unknown";
      }>;
      totalMacros: MacroTargets;
      prepInstructions: string[];
      storageNotes?: string;
    }>;
    dailyTotals: MacroTargets;
  }>;
  shoppingList: ShoppingListItem[];
  score: PlanScoreBreakdown;
  estimatedCostCents?: number;
  warnings: string[];
};
```

---

## 16) Example output

```json
{
  "macroTargets": {
    "caloriesKcal": 2400,
    "proteinG": 170,
    "carbsG": 260,
    "fatG": 75
  },
  "options": [
    {
      "label": "cheapest",
      "title": "Budget high-protein meal prep",
      "summary": "Chicken rice bowls, protein oats, egg snacks, and yogurt bowls using mostly common staples.",
      "estimatedCostCents": 6420,
      "warnings": [
        "Exact shelf availability was verified only for Kroger-supported items.",
        "Trader Joe's items are likely but not API-verified."
      ]
    }
  ]
}
```

---

## 17) Error handling

Show user-friendly errors:

- "We found nearby stores but could not verify inventory."
- "This retailer does not expose local stock through an API we support yet."
- "Nutrition match confidence is low for some items."
- "The generated plan is within 8% of calorie target but slightly low on carbs."
- "No stores found within 5 miles. Try a larger radius."

Never silently invent exact stock, price, or macros.

---

## 18) Tests

### Macro tests
- BMR calculation with known inputs.
- Cut/bulk calorie adjustment.
- Macro math sums correctly.
- Overrides work.

### Places tests
- Google Places response normalizes into `GroceryStore`.
- Missing address handled.
- Distance sorting works.

### Inventory tests
- Kroger product response normalizes.
- No inventory provider returns fallback warnings.
- Cache prevents repeated calls.

### Nutrition tests
- UPC path tries OpenFoodFacts first.
- Generic path tries USDA.
- Low-confidence matches require warning.

### Planner tests
- Allergens excluded.
- Avoid foods excluded.
- Daily macros within tolerance.
- Shopping list combines duplicate ingredients.
- Options differ meaningfully.

### E2E
- User enters profile + location.
- Stores appear.
- Generate plans.
- Shopping list renders.
- Warnings are visible.

---

## 19) Acceptance criteria

MVP is done when:

- User can enter stats, goal, preferences, and location.
- App calculates calorie/macro targets.
- App finds nearby grocery stores and shows addresses.
- App can generate a meal plan using mock or real product data.
- App resolves nutrition from at least one real nutrition provider.
- App generates 3 plan options.
- App creates a grouped shopping list.
- App labels unverified inventory clearly.
- App passes macro, planner, and E2E tests.

---

## 20) Reference links used for this spec

- Google Places API Nearby Search: https://developers.google.com/maps/documentation/places/web-service/nearby-search
- Google Places API Text Search: https://developers.google.com/maps/documentation/places/web-service/text-search
- Google Places data fields / field masks: https://developers.google.com/maps/documentation/places/web-service/data-fields
- Google Maps pricing: https://developers.google.com/maps/billing-and-pricing/pricing
- Google Places usage and billing: https://developers.google.com/maps/documentation/places/web-service/usage-and-billing
- Google Places types: https://developers.google.com/maps/documentation/places/web-service/place-types
- Kroger Locations API: https://developer.kroger.com/reference/api/location-api-public
- Kroger Products API: https://developer.kroger.com/reference/api/product-api-partner
- Kroger Product Search tutorial: https://developer.kroger.com/documentation/api-products/public/products/product-search
- Instacart Developer Platform API: https://docs.instacart.com/developer_platform_api
- Instacart Connect APIs: https://docs.instacart.com/connect
- USDA FoodData Central API Guide: https://fdc.nal.usda.gov/api-guide
- Open Food Facts API documentation: https://openfoodfacts.github.io/openfoodfacts-server/api/
- Edamam Food Database API docs: https://developer.edamam.com/food-database-api-docs
- Mifflin-St Jeor equation source: https://pubmed.ncbi.nlm.nih.gov/2305711/
- ISSN protein and exercise position stand: https://pubmed.ncbi.nlm.nih.gov/28642676/
- NCBI AMDR description: https://www.ncbi.nlm.nih.gov/books/NBK610333/
