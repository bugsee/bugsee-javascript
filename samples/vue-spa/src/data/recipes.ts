export interface Recipe {
  id: string;
  title: string;
  description: string;
  cookTimeMinutes: number;
  tags: string[];
  ingredients: string[];
  steps: string[];
  image: string;
}

// Seed data for the local "API" (src/api/server-plugin.ts). Mutated in-memory by the plugin as recipes
// are created/edited through the editor, so the app does real CRUD work against a real (if tiny) backend.
export const seedRecipes: Recipe[] = [
  {
    id: 'tomato-basil-soup',
    title: 'Tomato Basil Soup',
    description: 'A creamy, bright soup that comes together in under 30 minutes.',
    cookTimeMinutes: 30,
    tags: ['soup', 'vegetarian', 'quick'],
    ingredients: [
      '2 tbsp olive oil',
      '1 onion, diced',
      '3 cloves garlic, minced',
      '800g canned San Marzano tomatoes',
      '250ml vegetable stock',
      '100ml heavy cream',
      'A handful of fresh basil',
    ],
    steps: [
      'Heat the olive oil over medium heat and soften the onion, about 5 minutes.',
      'Add the garlic and cook for 1 minute until fragrant.',
      'Add the tomatoes and stock, bring to a simmer, and cook for 15 minutes.',
      'Blend until smooth, stir in the cream, and finish with torn basil.',
    ],
    image: 'https://images.unsplash.com/photo-1547592166-23ac45744acd?w=480',
  },
  {
    id: 'lemon-garlic-roast-chicken',
    title: 'Lemon Garlic Roast Chicken',
    description: 'A weeknight roast chicken with crisp skin and a bright pan sauce.',
    cookTimeMinutes: 75,
    tags: ['dinner', 'chicken', 'roast'],
    ingredients: [
      '1 whole chicken (about 1.6kg)',
      '1 lemon, halved',
      '1 head garlic, halved',
      '2 tbsp butter, softened',
      'Salt and pepper',
      'A few sprigs of thyme',
    ],
    steps: [
      'Preheat the oven to 220°C (425°F).',
      'Pat the chicken dry, rub with butter, and season generously.',
      'Stuff the cavity with lemon, garlic, and thyme.',
      'Roast for 60-70 minutes until the juices run clear, then rest for 10 minutes.',
    ],
    image: 'https://images.unsplash.com/photo-1598515213692-5f252f341f5c?w=480',
  },
  {
    id: 'chocolate-chip-cookies',
    title: 'Chewy Chocolate Chip Cookies',
    description: 'Crisp edges, chewy centers, and plenty of chocolate.',
    cookTimeMinutes: 25,
    tags: ['dessert', 'baking'],
    ingredients: [
      '225g butter, melted',
      '200g brown sugar',
      '100g white sugar',
      '2 eggs',
      '340g flour',
      '1 tsp baking soda',
      '300g chocolate chips',
    ],
    steps: [
      'Whisk the melted butter with both sugars until glossy.',
      'Beat in the eggs one at a time.',
      'Fold in the flour, baking soda, and chocolate chips.',
      'Bake at 190°C (375°F) for 10-12 minutes, until just set at the edges.',
    ],
    image: 'https://images.unsplash.com/photo-1499636136210-6f4ee915583e?w=480',
  },
  {
    id: 'thai-green-curry',
    title: 'Thai Green Curry',
    description: 'A fragrant curry with coconut milk, vegetables, and fresh herbs.',
    cookTimeMinutes: 40,
    tags: ['dinner', 'spicy', 'curry'],
    ingredients: [
      '3 tbsp green curry paste',
      '400ml coconut milk',
      '300g chicken thigh, sliced',
      '1 red bell pepper, sliced',
      '100g green beans',
      'Thai basil leaves',
      'Fish sauce and palm sugar to taste',
    ],
    steps: [
      'Fry the curry paste in a splash of coconut milk until fragrant.',
      'Add the chicken and cook until sealed.',
      'Pour in the remaining coconut milk and simmer 10 minutes.',
      'Add the vegetables and simmer until tender, then finish with basil, fish sauce, and sugar.',
    ],
    image: 'https://images.unsplash.com/photo-1455619452474-d2be8b1e70cd?w=480',
  },
  {
    id: 'avocado-toast',
    title: 'Loaded Avocado Toast',
    description: 'A five-minute breakfast that never gets old.',
    cookTimeMinutes: 5,
    tags: ['breakfast', 'quick', 'vegetarian'],
    ingredients: [
      '2 slices sourdough',
      '1 ripe avocado',
      '1/2 lemon, juiced',
      'Chili flakes',
      'Flaky salt',
      '1 soft-boiled egg (optional)',
    ],
    steps: [
      'Toast the sourdough until deeply golden.',
      'Mash the avocado with lemon juice and salt.',
      'Spread generously over the toast and top with chili flakes and egg.',
    ],
    image: 'https://images.unsplash.com/photo-1541519227354-08fa5d50c44d?w=480',
  },
];
