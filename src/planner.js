import { MEAL_TEMPLATES, STAPLE_QUERIES } from "./data.js";

const SCORE_WEIGHTS = {
  macroAccuracy: 0.35,
  availabilityScore: 0.2,
  priceScore: 0.15,
  preferenceScore: 0.15,
  prepEaseScore: 0.1,
  varietyScore: 0.05,
};

const OPTION_CONFIGS = [
  { id: "cheapest", label: "Cheapest", costBias: 0.82, varietyOffset: 0, preferTags: ["cheap"] },
  { id: "best_macros", label: "Best macro match", costBias: 1, varietyOffset: 1, preferTags: ["high_protein", "balanced"] },
  { id: "variety", label: "Most variety", costBias: 1.18, varietyOffset: 2, preferTags: ["quick", "meal_prep"] },
];

export async function loadStapleInventory(stores, inventoryProvider) {
  const products = [];
  const warnings = [];
  for (const store of stores) {
    for (const query of STAPLE_QUERIES) {
      const matches = await inventoryProvider.searchProducts({ store, query, limit: 1 });
      products.push(...matches);
    }
    if (!store.supportsInventoryLookup) {
      warnings.push(`${store.name}: exact shelf availability was not verified.`);
    }
  }
  return { products, warnings };
}

export async function resolveNutritionForProducts(products, nutritionProvider) {
  const byCategory = new Map();
  for (const product of products) {
    if (!byCategory.has(product.category)) {
      byCategory.set(product.category, await nutritionProvider.resolveNutrition({ product, ingredientName: product.name, upc: product.upc }));
    }
  }
  return [...byCategory.values()];
}

export function generateMealPlans(input) {
  const productsByCategory = groupProducts(input.products);
  const nutritionByIngredient = groupNutrition(input.nutrition);
  const warnings = [];
  const constraints = {
    allergies: input.constraints.allergies.map((value) => value.toLowerCase()),
    avoidFoods: input.constraints.avoidFoods.map((value) => value.toLowerCase()),
    dietStyle: input.constraints.dietStyle,
  };

  const options = OPTION_CONFIGS.map((config) => {
    const days = [];
    for (let dayIndex = 0; dayIndex < input.constraints.planningDays; dayIndex += 1) {
      const meals = buildDayMeals({
        dayIndex,
        mealsPerDay: input.constraints.mealsPerDay,
        macroTargets: input.macroTargets,
        config,
        productsByCategory,
        nutritionByIngredient,
        constraints,
      });
      days.push({ dayNumber: dayIndex + 1, meals, totals: sumMeals(meals) });
    }
    const averageTotals = averageDays(days);
    const estimatedCostCents = Math.round(days.reduce((sum, day) => sum + day.totals.costCents, 0) * config.costBias);
    const score = scorePlan({ averageTotals, targets: input.macroTargets, days, estimatedCostCents, stores: input.stores, constraints });
    const shoppingList = buildShoppingList(days, input.stores);
    return {
      id: config.id,
      label: config.label,
      summary: summarizePlan(config.id),
      days,
      averageTotals,
      estimatedCostCents,
      score,
      shoppingList,
      warnings: [
        "Nutrition values are estimates and should be verified for medical diets.",
        ...input.stores.filter((store) => !store.supportsInventoryLookup).map((store) => `${store.name}: availability not verified.`),
      ],
    };
  });

  if (!input.stores.some((store) => store.supportsInventoryLookup)) {
    warnings.push("No selected store has verified inventory support in this offline prototype.");
  }

  return { options, warnings };
}

function buildDayMeals(args) {
  const templates = rotateTemplates(args.dayIndex + args.config.varietyOffset);
  const meals = [];
  for (let i = 0; i < args.mealsPerDay; i += 1) {
    const template = templates[i % templates.length];
    const meal = buildMealFromTemplate(template, args);
    if (meal) meals.push(meal);
  }
  return tuneMealsToDailyTargets(meals, args.macroTargets);
}

function buildMealFromTemplate(template, args) {
  const ingredients = [];
  for (const slot of template.slots) {
    const product = chooseProduct(slot.allowedCategories, args.productsByCategory, args.constraints);
    if (!product) return null;
    const nutrition = args.nutritionByIngredient.get(product.category);
    if (!nutrition) return null;
    const grams = slot.defaultGrams;
    ingredients.push({
      slotName: slot.slotName,
      normalizedIngredient: product.category,
      productName: product.name,
      storeId: product.storeId,
      grams,
      minGrams: slot.minGrams,
      maxGrams: slot.maxGrams,
      priceCents: product.priceCents,
      sizeText: product.sizeText,
      available: product.available,
      nutrition,
      substitutes: substitutesFor(product.category, args.productsByCategory),
    });
  }
  const meal = {
    templateId: template.id,
    name: template.name,
    mealType: template.mealType,
    tags: template.tags,
    ingredients,
    prepInstructions: template.instructions,
    storageNotes: template.tags.includes("no_cook") ? "Keep chilled and eat within 3-4 days." : "Refrigerate cooked portions and reheat until hot.",
  };
  return { ...meal, totals: sumIngredients(meal.ingredients) };
}

function tuneMealsToDailyTargets(meals, targets) {
  if (meals.length === 0) return meals;
  for (const meal of meals) {
    scaleSlot(meal, "protein", targets.proteinG / meals.length, "proteinG");
    scaleSlot(meal, "carb", targets.carbsG / meals.length, "carbsG");
    scaleSlot(meal, "fat", targets.fatG / meals.length, "fatG");
    meal.totals = sumIngredients(meal.ingredients);
  }

  const daily = sumMeals(meals);
  const calorieRatio = clamp(targets.caloriesKcal / Math.max(1, daily.caloriesKcal), 0.82, 1.22);
  for (const meal of meals) {
    for (const ingredient of meal.ingredients) {
      if (ingredient.slotName !== "vegetable") {
        ingredient.grams = Math.round(clamp(ingredient.grams * calorieRatio, ingredient.minGrams, ingredient.maxGrams));
      }
    }
    meal.totals = sumIngredients(meal.ingredients);
  }
  return meals;
}

function scaleSlot(meal, slotName, targetAmount, macroKey) {
  const ingredient = meal.ingredients.find((item) => item.slotName === slotName);
  if (!ingredient) return;
  const perGram = ingredient.nutrition.per100g[macroKey] / 100;
  if (!perGram) return;
  ingredient.grams = Math.round(clamp(targetAmount / perGram, ingredient.minGrams, ingredient.maxGrams));
}

function chooseProduct(categories, productsByCategory, constraints) {
  for (const category of categories) {
    if (!allowedByDiet(category, constraints.dietStyle)) continue;
    const products = productsByCategory.get(category) || [];
    const product = products.find((candidate) => !blocked(candidate, constraints));
    if (product) return product;
  }
  return null;
}

function blocked(product, constraints) {
  const text = `${product.name} ${product.category}`.toLowerCase();
  return [...constraints.allergies, ...constraints.avoidFoods].some((term) => term && text.includes(term));
}

function allowedByDiet(category, dietStyle) {
  const meat = ["chicken", "turkey", "eggs"];
  const fish = ["salmon", "tuna"];
  const dairy = ["greek_yogurt"];
  if (dietStyle === "vegan") return !meat.includes(category) && !fish.includes(category) && !dairy.includes(category);
  if (dietStyle === "vegetarian") return !meat.includes(category) && !fish.includes(category);
  if (dietStyle === "pescatarian") return !meat.includes(category);
  return true;
}

function sumIngredients(ingredients) {
  return ingredients.reduce(
    (totals, ingredient) => {
      const factor = ingredient.grams / 100;
      totals.caloriesKcal += ingredient.nutrition.per100g.caloriesKcal * factor;
      totals.proteinG += ingredient.nutrition.per100g.proteinG * factor;
      totals.carbsG += ingredient.nutrition.per100g.carbsG * factor;
      totals.fatG += ingredient.nutrition.per100g.fatG * factor;
      totals.costCents += estimateIngredientCost(ingredient);
      return totals;
    },
    { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0, costCents: 0 },
  );
}

function sumMeals(meals) {
  return roundTotals(meals.reduce(
    (totals, meal) => {
      totals.caloriesKcal += meal.totals.caloriesKcal;
      totals.proteinG += meal.totals.proteinG;
      totals.carbsG += meal.totals.carbsG;
      totals.fatG += meal.totals.fatG;
      totals.costCents += meal.totals.costCents;
      return totals;
    },
    { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0, costCents: 0 },
  ));
}

function averageDays(days) {
  const totals = days.reduce(
    (sum, day) => {
      sum.caloriesKcal += day.totals.caloriesKcal;
      sum.proteinG += day.totals.proteinG;
      sum.carbsG += day.totals.carbsG;
      sum.fatG += day.totals.fatG;
      sum.costCents += day.totals.costCents;
      return sum;
    },
    { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0, costCents: 0 },
  );
  const dayCount = Math.max(1, days.length);
  return roundTotals({
    caloriesKcal: totals.caloriesKcal / dayCount,
    proteinG: totals.proteinG / dayCount,
    carbsG: totals.carbsG / dayCount,
    fatG: totals.fatG / dayCount,
    costCents: totals.costCents / dayCount,
  });
}

function scorePlan({ averageTotals, targets, days, estimatedCostCents, stores, constraints }) {
  const macroAccuracy = averageScore([
    percentCloseness(averageTotals.caloriesKcal, targets.caloriesKcal),
    percentCloseness(averageTotals.proteinG, targets.proteinG),
    percentCloseness(averageTotals.carbsG, targets.carbsG),
    percentCloseness(averageTotals.fatG, targets.fatG),
  ]);
  const availabilityScore = Math.round(100 * stores.filter((store) => store.supportsInventoryLookup).length / Math.max(1, stores.length));
  const priceScore = Math.round(clamp(100 - estimatedCostCents / Math.max(1, days.length) / 120, 45, 100));
  const preferenceScore = constraints.allergies.length || constraints.avoidFoods.length ? 95 : 88;
  const prepEaseScore = days.some((day) => day.meals.some((meal) => meal.tags.includes("quick") || meal.tags.includes("no_cook"))) ? 92 : 82;
  const varietyScore = Math.round(clamp(new Set(days.flatMap((day) => day.meals.map((meal) => meal.templateId))).size * 25, 60, 100));
  const totalScore = Math.round(
    macroAccuracy * SCORE_WEIGHTS.macroAccuracy +
      availabilityScore * SCORE_WEIGHTS.availabilityScore +
      priceScore * SCORE_WEIGHTS.priceScore +
      preferenceScore * SCORE_WEIGHTS.preferenceScore +
      prepEaseScore * SCORE_WEIGHTS.prepEaseScore +
      varietyScore * SCORE_WEIGHTS.varietyScore,
  );
  return { macroAccuracy, priceScore, varietyScore, prepEaseScore, availabilityScore, preferenceScore, totalScore };
}

function buildShoppingList(days, stores) {
  const storeById = new Map(stores.map((store) => [store.providerPlaceId, store]));
  const itemMap = new Map();
  for (const meal of days.flatMap((day) => day.meals)) {
    for (const ingredient of meal.ingredients) {
      const key = `${ingredient.storeId}:${ingredient.normalizedIngredient}`;
      const existing = itemMap.get(key) || {
        normalizedIngredient: ingredient.normalizedIngredient,
        productName: ingredient.productName,
        storeId: ingredient.storeId,
        storeName: storeById.get(ingredient.storeId)?.name || "Mock grocery",
        quantityNeededG: 0,
        estimatedCostCents: 0,
        available: ingredient.available,
        substitutes: ingredient.substitutes,
      };
      existing.quantityNeededG += ingredient.grams;
      existing.estimatedCostCents += estimateIngredientCost(ingredient);
      itemMap.set(key, existing);
    }
  }
  return [...itemMap.values()].map((item) => ({
    ...item,
    quantityNeededG: Math.round(item.quantityNeededG),
    quantityNeededText: formatGrams(item.quantityNeededG),
    packageCount: Math.max(1, Math.ceil(item.quantityNeededG / 454)),
    estimatedCostCents: Math.round(item.estimatedCostCents),
  }));
}

function substitutesFor(category, productsByCategory) {
  const substitutions = {
    chicken: ["turkey", "tofu", "tuna"],
    turkey: ["chicken", "tofu"],
    tofu: ["beans", "lentils", "eggs"],
    rice: ["potatoes", "tortillas"],
    broccoli: ["spinach"],
    greek_yogurt: ["protein_powder", "eggs"],
    peanut_butter: ["avocado", "olive_oil"],
  };
  return (substitutions[category] || [])
    .flatMap((sub) => productsByCategory.get(sub) || [])
    .slice(0, 2)
    .map((product) => ({ productId: product.providerProductId, name: product.name, reason: "Similar macro role or meal slot." }));
}

function groupProducts(products) {
  const map = new Map();
  for (const product of products) {
    const list = map.get(product.category) || [];
    list.push(product);
    map.set(product.category, list.sort((a, b) => (a.priceCents || 0) - (b.priceCents || 0)));
  }
  return map;
}

function groupNutrition(nutrition) {
  const map = new Map();
  for (const item of nutrition) {
    if (item.categoryKey) map.set(item.categoryKey, item);
    map.set(item.ingredientName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), item);
  }
  return map;
}

function rotateTemplates(offset) {
  return [...MEAL_TEMPLATES.slice(offset % MEAL_TEMPLATES.length), ...MEAL_TEMPLATES.slice(0, offset % MEAL_TEMPLATES.length)];
}

function estimateIngredientCost(ingredient) {
  const packagePrice = ingredient.priceCents || 350;
  const packageGrams = ingredient.sizeText?.includes("5 lb") ? 2268 : ingredient.sizeText?.includes("32 oz") ? 907 : ingredient.sizeText?.includes("16 oz") ? 454 : 454;
  return packagePrice * (ingredient.grams / packageGrams);
}

function percentCloseness(value, target) {
  return Math.round(clamp(100 - (Math.abs(value - target) / Math.max(1, target)) * 100, 0, 100));
}

function averageScore(values) {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function roundTotals(totals) {
  return {
    caloriesKcal: Math.round(totals.caloriesKcal),
    proteinG: Math.round(totals.proteinG),
    carbsG: Math.round(totals.carbsG),
    fatG: Math.round(totals.fatG),
    costCents: Math.round(totals.costCents),
  };
}

function formatGrams(grams) {
  if (grams >= 454) return `${(grams / 454).toFixed(1)} lb`;
  return `${Math.round(grams)} g`;
}

function summarizePlan(id) {
  if (id === "cheapest") return "Repeats lower-cost staples and keeps the ingredient list tight.";
  if (id === "best_macros") return "Prioritizes protein and macro accuracy with familiar meal-prep bases.";
  return "Rotates templates more often for flavor and texture variety.";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
