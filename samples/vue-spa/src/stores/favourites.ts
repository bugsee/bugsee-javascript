import { defineStore } from 'pinia';

const STORAGE_KEY = 'bugsee-recipe-book:favourites';

function readStored(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeStored(ids: string[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}

// Favourites persisted in localStorage (per the app concept in docs/samples/PLAN.md §5.3) — genuinely
// used by the app (the heart toggle on every recipe card and the Favourites page), not a scenario prop.
export const useFavouritesStore = defineStore('favourites', {
  state: () => ({ ids: readStored() as string[] }),
  getters: {
    isFavourite: (state) => (id: string) => state.ids.includes(id),
  },
  actions: {
    toggle(id: string): void {
      this.ids = this.ids.includes(id) ? this.ids.filter((x) => x !== id) : [...this.ids, id];
      writeStored(this.ids);
    },
  },
});
