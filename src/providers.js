import { MOCK_PRODUCTS, MOCK_STORES, NUTRITION } from "./data.js";

export class MockPlacesProvider {
  async searchGroceryStores(input) {
    const radiusMiles = input.radiusMeters / 1609.344;
    const query = (input.query || "").toLowerCase();
    return MOCK_STORES.filter((store) => store.distanceMiles <= radiusMiles || radiusMiles >= 5)
      .filter((store) => !query || `${store.name} ${store.chain} ${store.placeTypes.join(" ")}`.toLowerCase().includes(query))
      .map((store) => ({ ...store }))
      .slice(0, input.maxResults || 8);
  }
}

export class MockInventoryProvider {
  supportsStore() {
    return true;
  }

  async searchProducts(input) {
    const query = input.query.toLowerCase();
    const priceMultiplier = input.store.inventoryProvider === "kroger" ? 1 : input.store.inventoryProvider === "manual" ? 0.94 : 1.08;
    return MOCK_PRODUCTS.filter((product) => product.searchTerms.some((term) => term.includes(query) || query.includes(term)))
      .slice(0, input.limit || 3)
      .map((product) => ({
        ...product,
        storeId: input.store.providerPlaceId,
        priceCents: product.priceCents ? Math.round(product.priceCents * priceMultiplier) : undefined,
        available: input.store.supportsInventoryLookup ? product.available : "unknown",
      }));
  }
}

export class CompositeNutritionProvider {
  async resolveNutrition(input) {
    const key = input.product?.category || normalizeIngredient(input.ingredientName);
    const resolved = NUTRITION[key] || {
      ingredientName: input.ingredientName,
      matchedSource: "estimated",
      confidence: "low",
      per100g: { caloriesKcal: 100, proteinG: 5, carbsG: 15, fatG: 2 },
      notes: "Generic fallback estimate.",
    };
    return { ...resolved, categoryKey: key };
  }
}

export class GooglePlacesProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async searchGroceryStores() {
    throw new Error("Google Places is not wired in the offline prototype. Use MockPlacesProvider until an API route is added.");
  }
}

export class KrogerInventoryProvider {
  supportsStore(store) {
    return store.inventoryProvider === "kroger";
  }

  async searchProducts() {
    throw new Error("Kroger OAuth and Products API are intentionally stubbed for phase 3.");
  }
}

export class InstacartInventoryProvider {
  supportsStore(store) {
    return store.inventoryProvider === "instacart";
  }

  async searchProducts() {
    throw new Error("Instacart API access is intentionally stubbed for approved partner credentials.");
  }
}

function normalizeIngredient(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
