// Local persistence for the Markdown Notes app — plain `localStorage`, no backend database (the
// backend under test in this sample is the SOURCE-MAP upload pipeline, not a data API). Real notes,
// real CRUD, real IDs — this is the "genuinely useful app" half of the sample (PLAN §3).
import type { Note, NoteDraft } from './types';

const STORAGE_KEY = 'bugsee-sample.webpack-sourcemaps.notes.v1';

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `note-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function seed(): Note[] {
  const now = Date.now();
  return [
    {
      id: newId(),
      title: 'Welcome to Markdown Notes',
      body: [
        '# Welcome',
        '',
        'This is a **Bugsee sample app** built to exercise `@bugsee/webpack-plugin` and',
        '`@bugsee/bundler-plugin-core` — a real webpack 5 build, not a framework.',
        '',
        '- Edit this note',
        '- Create a new one from the sidebar',
        '- Open the *Scenarios* panel to drive every SDK capture path by hand',
        '',
        '```js',
        'console.log("markdown code fences render too");',
        '```',
      ].join('\n'),
      tags: ['welcome', 'bugsee'],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: newId(),
      title: 'Shopping list',
      body: '# Shopping\n\n- [ ] Coffee\n- [ ] Oat milk\n- [ ] Sourdough',
      tags: ['personal'],
      createdAt: now - 60_000,
      updatedAt: now - 60_000,
    },
  ];
}

function readAll(): Note[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    const initial = seed();
    writeAll(initial);
    return initial;
  }
  try {
    const parsed = JSON.parse(raw) as Note[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(notes: Note[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

export const notesStore = {
  list(): Note[] {
    return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
  },

  get(id: string): Note | undefined {
    return readAll().find((n) => n.id === id);
  },

  create(draft: NoteDraft): Note {
    const now = Date.now();
    const note: Note = { id: newId(), createdAt: now, updatedAt: now, ...draft };
    const all = readAll();
    all.push(note);
    writeAll(all);
    return note;
  },

  update(id: string, draft: Partial<NoteDraft>): Note | undefined {
    const all = readAll();
    const idx = all.findIndex((n) => n.id === id);
    if (idx === -1) return undefined;
    const updated: Note = { ...all[idx], ...draft, updatedAt: Date.now() };
    all[idx] = updated;
    writeAll(all);
    return updated;
  },

  remove(id: string): void {
    writeAll(readAll().filter((n) => n.id !== id));
  },

  count(): number {
    return readAll().length;
  },
};
