/*
 * recipes.js — recipe data for Cook Mode.
 *
 * Kept in a plain, cacheable file so the Service Worker can store it for
 * offline use (ULO: persistence / offline). Each step optionally lists the
 * ingredients it needs, which Cook Mode shows as the "ingredient peek".
 */
const RECIPES = {
  "garlic-butter-pasta": {
    id: "garlic-butter-pasta",
    title: "Garlic Butter Pasta",
    serves: 2,
    time: "~20 min",
    summary: "A quick weeknight pasta — 5 ingredients, one pan, ready in about 20 minutes.",
    ingredients: [
      "200 g spaghetti",
      "3 cloves garlic, thinly sliced",
      "50 g butter",
      "2 tbsp olive oil",
      "Salt, pepper and a handful of parsley"
    ],
    steps: [
      { text: "Bring a large pot of salted water to the boil.", needs: ["Salt", "Water"] },
      { text: "Add the spaghetti and cook until just tender, about 9 minutes.", needs: ["200 g spaghetti"] },
      { text: "While the pasta cooks, melt the butter with the olive oil in a wide pan over low heat.", needs: ["50 g butter", "2 tbsp olive oil"] },
      { text: "Add the sliced garlic and cook gently until soft and fragrant, about 2 minutes. Do not let it brown.", needs: ["3 cloves garlic"] },
      { text: "Scoop out a cup of pasta water, then drain the pasta and add it to the garlic butter.", needs: [] },
      { text: "Toss with a splash of pasta water, season, scatter over the parsley and serve.", needs: ["Salt, pepper, parsley"] }
    ]
  }
};

// The recipe this page shows. (A real site would read this from the URL.)
const CURRENT_RECIPE_ID = "garlic-butter-pasta";
