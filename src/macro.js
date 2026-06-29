export const ACTIVITY_MULTIPLIER = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  very_active: 1.725,
  athlete: 1.9,
};

export const GOAL_CALORIE_ADJUSTMENT = {
  cut: { slow: -250, standard: -500, aggressive: -750 },
  maintain: { slow: 0, standard: 0, aggressive: 0 },
  lean_bulk: { slow: 150, standard: 250, aggressive: 350 },
  bulk: { slow: 250, standard: 400, aggressive: 500 },
};

export function calculateBmrMifflinStJeor(input) {
  const base = 10 * input.weightKg + 6.25 * input.heightCm - 5 * input.age;
  if (input.biologicalSex === "male") return base + 5;
  if (input.biologicalSex === "female") return base - 161;
  return base - 78;
}

export function proteinTargetG(weightKg, goal) {
  if (goal === "cut") return Math.round(weightKg * 2.0);
  if (goal === "lean_bulk" || goal === "bulk") return Math.round(weightKg * 1.8);
  return Math.round(weightKg * 1.6);
}

export function fatTargetG(calorieTarget) {
  return Math.round((calorieTarget * 0.25) / 9);
}

export function carbTargetG(calorieTarget, proteinG, fatG) {
  return Math.max(0, Math.round((calorieTarget - proteinG * 4 - fatG * 9) / 4));
}

export function calculateMacroTargets(profile, overrides = {}) {
  const warnings = [];
  if (profile.age < 18) {
    warnings.push("MVP guardrail: pediatric nutrition logic is not supported. Use adult inputs only.");
  }

  const bmr = Math.round(calculateBmrMifflinStJeor(profile));
  const tdee = Math.round(bmr * ACTIVITY_MULTIPLIER[profile.activityLevel]);
  const rate = profile.targetRate || "standard";
  const goalAdjustment = GOAL_CALORIE_ADJUSTMENT[profile.goal]?.[rate] ?? 0;
  let caloriesKcal = Math.round(tdee + goalAdjustment);

  if (overrides.calorieTargetOverride) {
    caloriesKcal = Math.round(overrides.calorieTargetOverride);
    warnings.push("Calorie target override is active.");
  } else {
    if (profile.biologicalSex === "female" && caloriesKcal < 1200) {
      caloriesKcal = 1200;
      warnings.push("Calories were raised to the MVP adult guardrail of 1200 kcal/day.");
    }
    if (profile.biologicalSex === "male" && caloriesKcal < 1500) {
      caloriesKcal = 1500;
      warnings.push("Calories were raised to the MVP adult guardrail of 1500 kcal/day.");
    }
  }

  if (profile.goal === "cut" && rate === "aggressive") {
    warnings.push("Aggressive cuts can affect energy, adherence, and health. Consider professional guidance.");
  }

  const proteinG = Math.round(overrides.proteinGOverride || proteinTargetG(profile.weightKg, profile.goal));
  const fatG = Math.round(overrides.fatGOverride || fatTargetG(caloriesKcal));
  const carbsG = Math.round(overrides.carbGOverride || carbTargetG(caloriesKcal, proteinG, fatG));

  return {
    bmr,
    tdee,
    targets: {
      caloriesKcal,
      proteinG,
      carbsG,
      fatG,
      fiberGMin: 25,
    },
    warnings,
  };
}
