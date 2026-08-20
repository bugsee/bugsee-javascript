import { defineStore } from 'pinia';
import type { Recipe } from '../data/recipes';

// The Pinia store backing the recipe list/detail/editor — real state, real CRUD against the local API
// (src/api/server-plugin.ts). Every network call here is plain `fetch`, so it is exercised by @bugsee/vue's
// re-exported @bugsee/browser network capture (S7) as a side effect of the app just working normally.

export interface RecipesState {
  recipes: Recipe[];
  loading: boolean;
  error: string | null;
}

export const useRecipesStore = defineStore('recipes', {
  state: (): RecipesState => ({ recipes: [], loading: false, error: null }),
  getters: {
    byId: (state) => (id: string) => state.recipes.find((r) => r.id === id),
  },
  actions: {
    async fetchAll(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        const res = await fetch('/api/recipes');
        if (!res.ok) throw new Error(`fetchAll failed: ${res.status}`);
        this.recipes = (await res.json()) as Recipe[];
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.loading = false;
      }
    },
    async fetchOne(id: string): Promise<Recipe | null> {
      const cached = this.byId(id);
      if (cached) return cached;
      const res = await fetch(`/api/recipes/${encodeURIComponent(id)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`fetchOne failed: ${res.status}`);
      const recipe = (await res.json()) as Recipe;
      const idx = this.recipes.findIndex((r) => r.id === id);
      if (idx === -1) this.recipes.push(recipe);
      else this.recipes[idx] = recipe;
      return recipe;
    },
    async create(recipe: Omit<Recipe, 'id'>): Promise<Recipe> {
      const res = await fetch('/api/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recipe),
      });
      if (!res.ok) throw new Error(`create failed: ${res.status}`);
      const created = (await res.json()) as Recipe;
      this.recipes = [created, ...this.recipes];
      return created;
    },
    async update(id: string, patch: Partial<Recipe>): Promise<Recipe> {
      const res = await fetch(`/api/recipes/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`update failed: ${res.status}`);
      const updated = (await res.json()) as Recipe;
      const idx = this.recipes.findIndex((r) => r.id === id);
      if (idx !== -1) this.recipes[idx] = updated;
      return updated;
    },
  },
});
