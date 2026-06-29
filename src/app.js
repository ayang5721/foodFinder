import { calculateMacroTargets } from "./macro.js";
import { CompositeNutritionProvider, MockInventoryProvider, MockPlacesProvider } from "./providers.js";
import { generateMealPlans, loadStapleInventory, resolveNutritionForProducts } from "./planner.js";

const state = {
  stores: [],
  selectedOptionId: "cheapest",
  lastResult: null,
};

const placesProvider = new MockPlacesProvider();
const inventoryProvider = new MockInventoryProvider();
const nutritionProvider = new CompositeNutritionProvider();

const form = document.querySelector("#plannerForm");
const findStoresBtn = document.querySelector("#findStoresBtn");
const useGpsBtn = document.querySelector("#useGpsBtn");
const storeResults = document.querySelector("#storeResults");
const macroPanel = document.querySelector("#macroPanel");
const planPanel = document.querySelector("#planPanel");

findStoresBtn.addEventListener("click", async () => {
  await findStores();
});

useGpsBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    showInlineMessage(storeResults, "GPS is not available in this browser.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      form.elements.locationQuery.value = `${position.coords.latitude.toFixed(4)}, ${position.coords.longitude.toFixed(4)}`;
      await findStores({ kind: "gps", lat: position.coords.latitude, lng: position.coords.longitude });
    },
    () => showInlineMessage(storeResults, "GPS permission was not granted. Typed location still works in mock mode."),
  );
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = form.querySelector("button[type='submit']");
  submitButton.disabled = true;
  submitButton.textContent = "Generating...";
  try {
    if (state.stores.length === 0) await findStores();
    const profile = readProfile();
    const overrides = readOverrides();
    const macroResult = calculateMacroTargets(profile, overrides);
    const selectedStores = getSelectedStores();
    const inventory = await loadStapleInventory(selectedStores, inventoryProvider);
    const nutrition = await resolveNutritionForProducts(inventory.products, nutritionProvider);
    const planResult = generateMealPlans({
      userProfile: profile,
      macroTargets: macroResult.targets,
      stores: selectedStores,
      products: inventory.products,
      nutrition,
      constraints: {
        mealsPerDay: profile.mealsPerDay,
        planningDays: profile.planningDays,
        allergies: profile.allergies,
        avoidFoods: profile.avoidFoods,
        dietStyle: profile.dietStyle,
      },
    });

    state.lastResult = {
      macroResult,
      stores: selectedStores,
      options: planResult.options,
      warnings: [...macroResult.warnings, ...inventory.warnings, ...planResult.warnings],
    };
    state.selectedOptionId = planResult.options[0]?.id || "cheapest";
    renderMacroPanel(state.lastResult);
    renderPlanPanel(state.lastResult);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Generate plans";
  }
});

await findStores();

async function findStores(locationOverride) {
  const radiusMeters = milesToMeters(numberValue("radiusMiles", 5));
  const stores = await placesProvider.searchGroceryStores({
    ...(locationOverride || readLocation()),
    radiusMeters,
    query: form.elements.storeQuery.value,
    maxResults: 8,
  });
  state.stores = stores;
  renderStores(stores);
}

function readProfile() {
  return {
    age: numberValue("age", 32),
    biologicalSex: form.elements.biologicalSex.value,
    heightCm: numberValue("heightCm", 178),
    weightKg: numberValue("weightKg", 82),
    activityLevel: form.elements.activityLevel.value,
    goal: form.elements.goal.value,
    targetRate: form.elements.targetRate.value,
    mealsPerDay: clamp(numberValue("mealsPerDay", 4), 3, 5),
    planningDays: clamp(numberValue("planningDays", 4), 1, 7),
    dietStyle: form.elements.dietStyle.value,
    allergies: csv("allergies"),
    avoidFoods: csv("avoidFoods"),
    preferredFoods: csv("preferredFoods"),
    cookingSkill: form.elements.cookingSkill.value,
    equipment: [...form.elements.equipment.selectedOptions].map((option) => option.value),
    budgetLevel: form.elements.budgetLevel.value,
  };
}

function readOverrides() {
  return {
    calorieTargetOverride: optionalNumber("calorieTargetOverride"),
    proteinGOverride: optionalNumber("proteinGOverride"),
  };
}

function readLocation() {
  const query = form.elements.locationQuery.value.trim() || "Los Angeles, CA";
  return { kind: "text", query };
}

function renderStores(stores) {
  if (stores.length === 0) {
    showInlineMessage(storeResults, "No mock stores matched. Clear the store search query or increase the radius.");
    return;
  }
  storeResults.innerHTML = stores
    .map((store, index) => {
      const status = inventoryStatus(store);
      return `
        <label class="store-card">
          <input type="checkbox" name="storeId" value="${escapeHtml(store.providerPlaceId)}" ${index < 2 ? "checked" : ""} />
          <strong>${escapeHtml(store.name)}</strong>
          <p>${escapeHtml(store.formattedAddress || "Address unavailable")}</p>
          <p>${store.distanceMiles?.toFixed(1) || "?"} mi - ${escapeHtml(status)}</p>
        </label>
      `;
    })
    .join("");
}

function renderMacroPanel(result) {
  const { bmr, tdee, targets } = result.macroResult;
  macroPanel.innerHTML = `
    <h2>Macro targets</h2>
    <div class="macro-grid">
      ${metric("Calories", targets.caloriesKcal, "kcal")}
      ${metric("Protein", targets.proteinG, "g")}
      ${metric("Carbs", targets.carbsG, "g")}
      ${metric("Fat", targets.fatG, "g")}
    </div>
    <p class="muted">BMR ${bmr} kcal, TDEE ${tdee} kcal. Fiber floor: ${targets.fiberGMin || 25} g/day.</p>
    ${renderWarnings(result.warnings)}
  `;
}

function renderPlanPanel(result) {
  const option = result.options.find((candidate) => candidate.id === state.selectedOptionId) || result.options[0];
  if (!option) {
    planPanel.innerHTML = "<h2>Meal plan options</h2><div class='empty-state'>No option could be generated from the selected constraints.</div>";
    return;
  }
  planPanel.innerHTML = `
    <h2>Meal plan options</h2>
    <div class="tabs">
      ${result.options.map((candidate) => `<button type="button" class="tab ${candidate.id === option.id ? "active" : ""}" data-option="${candidate.id}">${escapeHtml(candidate.label)}</button>`).join("")}
    </div>
    <div class="plan-summary">
      <div class="summary-top">
        <div>
          <h3>${escapeHtml(option.label)}</h3>
          <p>${escapeHtml(option.summary)}</p>
        </div>
        <span class="score">${option.score.totalScore}/100</span>
      </div>
      <div class="macro-grid">
        ${metric("Avg kcal", option.averageTotals.caloriesKcal, "")}
        ${metric("Protein", option.averageTotals.proteinG, "g")}
        ${metric("Carbs", option.averageTotals.carbsG, "g")}
        ${metric("Fat", option.averageTotals.fatG, "g")}
      </div>
      <p class="muted">Estimated ${money(option.estimatedCostCents)} for ${option.days.length} days. Macro accuracy ${option.score.macroAccuracy}/100, availability ${option.score.availabilityScore}/100.</p>
      ${renderDay(option.days[0])}
      ${renderShoppingList(option.shoppingList)}
      ${renderWarnings(option.warnings)}
    </div>
  `;
  planPanel.querySelectorAll("[data-option]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedOptionId = button.dataset.option;
      renderPlanPanel(result);
    });
  });
}

function renderDay(day) {
  return `
    <div>
      <h3>Day ${day.dayNumber}</h3>
      ${day.meals.map(renderMeal).join("")}
    </div>
  `;
}

function renderMeal(meal) {
  return `
    <article class="meal-card">
      <div>
        <strong>${escapeHtml(meal.name)}</strong>
        <div class="meal-meta">${meal.totals.caloriesKcal} kcal - ${meal.totals.proteinG}P / ${meal.totals.carbsG}C / ${meal.totals.fatG}F - ${money(meal.totals.costCents)}</div>
      </div>
      <ul class="ingredient-list">
        ${meal.ingredients.map((ingredient) => `<li>${escapeHtml(ingredient.productName)} - ${ingredient.grams} g (${availabilityLabel(ingredient.available)})</li>`).join("")}
      </ul>
      <ol class="prep-list">
        ${meal.prepInstructions.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}
      </ol>
      <p class="muted">${escapeHtml(meal.storageNotes)}</p>
    </article>
  `;
}

function renderShoppingList(items) {
  const byStore = new Map();
  for (const item of items) {
    const list = byStore.get(item.storeName) || [];
    list.push(item);
    byStore.set(item.storeName, list);
  }
  return `
    <div>
      <h3>Shopping list</h3>
      ${[...byStore.entries()].map(([storeName, storeItems]) => `
        <div class="shopping-group">
          <strong>${escapeHtml(storeName)}</strong>
          <ul class="shopping-list">
            ${storeItems.map((item) => `
              <li>
                ${escapeHtml(item.productName || item.normalizedIngredient)} - ${item.quantityNeededText}, est. ${money(item.estimatedCostCents)} (${availabilityLabel(item.available)})
                ${item.substitutes.length ? `<div class="muted">Subs: ${item.substitutes.map((sub) => escapeHtml(sub.name)).join(", ")}</div>` : ""}
              </li>
            `).join("")}
          </ul>
        </div>
      `).join("")}
    </div>
  `;
}

function renderWarnings(warnings) {
  const unique = [...new Set(warnings)].filter(Boolean);
  if (unique.length === 0) return "";
  return `
    <div class="warning">
      <strong>Notes</strong>
      <ul class="warning-list">
        ${unique.slice(0, 5).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}
      </ul>
    </div>
  `;
}

function getSelectedStores() {
  const selectedIds = [...form.querySelectorAll("input[name='storeId']:checked")].map((input) => input.value);
  const selected = state.stores.filter((store) => selectedIds.includes(store.providerPlaceId));
  return selected.length ? selected : state.stores.slice(0, 2);
}

function metric(label, value, unit) {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong>${unit ? `<span>${unit}</span>` : ""}</div>`;
}

function inventoryStatus(store) {
  if (store.inventoryProvider === "kroger") return "Partial catalog available";
  if (store.inventoryProvider === "manual") return "Stock available through manual/API";
  return "Availability not verified";
}

function availabilityLabel(value) {
  if (value === true) return "available";
  if (value === false) return "unavailable";
  return "unknown";
}

function showInlineMessage(element, message) {
  element.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function numberValue(name, fallback) {
  const value = Number(form.elements[name].value);
  return Number.isFinite(value) ? value : fallback;
}

function optionalNumber(name) {
  const value = Number(form.elements[name].value);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function csv(name) {
  return form.elements[name].value
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function milesToMeters(miles) {
  return Math.round(miles * 1609.344);
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
