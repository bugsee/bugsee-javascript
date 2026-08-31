// The "Markdown Notes" app itself — plain DOM, no framework (the framework under test here is the
// webpack BUILD, not a UI framework). Real CRUD against localStorage (src/storage.ts), a live markdown
// preview (src/markdown.ts), a "suggest a prompt" fetch, a "backup" POST, and a presence WebSocket —
// genuine functionality the Scenario panel then drives edge cases against.
import { getClient } from './bugsee';
import { renderMarkdown } from './markdown';
import { notesStore } from './storage';
import type { Note } from './types';

let selectedId: string | undefined;
let presenceSocket: WebSocket | undefined;
let container: HTMLElement | undefined;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

function connectPresence(): void {
  if (presenceSocket !== undefined) return;
  try {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}/api/presence`);
    socket.addEventListener('open', () => {
      getClient()?.addBreadcrumb({ type: 'navigation', category: 'presence', message: 'presence socket open' });
    });
    socket.addEventListener('message', (ev) => {
      // eslint-disable-next-line no-console
      console.log('[presence]', ev.data);
    });
    presenceSocket = socket;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('presence socket unavailable', err);
  }
}

function announceEditing(note: Note): void {
  if (presenceSocket?.readyState === WebSocket.OPEN) {
    presenceSocket.send(JSON.stringify({ type: 'editing', noteId: note.id, title: note.title }));
  }
}

function renderList(): string {
  const notes = notesStore.list();
  return notes
    .map(
      (n) => `
      <li class="note-item ${n.id === selectedId ? 'selected' : ''}" data-note-id="${n.id}" data-testid="note-item">
        <div class="note-item-title">${escapeHtml(n.title || 'Untitled')}</div>
        <div class="note-item-meta">${fmtDate(n.updatedAt)} · ${n.tags.map((t) => `#${escapeHtml(t)}`).join(' ')}</div>
      </li>`,
    )
    .join('');
}

function renderEditor(): string {
  const note = selectedId !== undefined ? notesStore.get(selectedId) : undefined;
  if (note === undefined) {
    return `<div class="empty-state">Select a note, or create a new one.</div>`;
  }
  return `
    <div class="editor">
      <input class="note-title-input" data-testid="note-title" value="${escapeHtml(note.title)}" placeholder="Title" />
      <input class="note-tags-input" data-testid="note-tags" value="${escapeHtml(note.tags.join(', '))}" placeholder="tags, comma, separated" />
      <div class="editor-panes">
        <textarea class="note-body-input" data-testid="note-body" spellcheck="false">${escapeHtml(note.body)}</textarea>
        <div class="note-preview" data-testid="note-preview">${renderMarkdown(note.body)}</div>
      </div>
      <div class="editor-actions">
        <button data-testid="note-suggest-prompt" class="secondary">Suggest a prompt</button>
        <button data-testid="note-backup" class="secondary">Backup all notes</button>
        <button data-testid="note-delete" class="danger">Delete</button>
        <span class="save-indicator" data-testid="save-indicator"></span>
      </div>
    </div>`;
}

function render(): void {
  if (container === undefined) return;
  container.innerHTML = `
    <div class="notes-layout">
      <aside class="notes-sidebar">
        <div class="sidebar-header">
          <input class="search-input" data-testid="note-search" placeholder="Search notes…" />
          <button data-testid="note-new" class="primary">New note</button>
        </div>
        <ul class="note-list" data-testid="note-list">${renderList()}</ul>
      </aside>
      <main class="notes-main">${renderEditor()}</main>
    </div>`;
  wire();
}

function saveIndicator(text: string): void {
  const el = container?.querySelector<HTMLElement>('[data-testid="save-indicator"]');
  if (el) el.textContent = text;
}

function wire(): void {
  if (container === undefined) return;

  container.querySelector('[data-testid="note-new"]')?.addEventListener('click', () => {
    const created = notesStore.create({ title: 'Untitled note', body: '', tags: [] });
    selectedId = created.id;
    getClient()?.event('note_created', { via: 'new-button' });
    getClient()?.addBreadcrumb({ type: 'user', category: 'notes', message: 'created a note' });
    render();
  });

  container.querySelectorAll<HTMLElement>('[data-note-id]').forEach((el) => {
    el.addEventListener('click', () => {
      selectedId = el.dataset.noteId;
      render();
    });
  });

  const searchInput = container.querySelector<HTMLInputElement>('[data-testid="note-search"]');
  searchInput?.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    container?.querySelectorAll<HTMLElement>('[data-note-id]').forEach((el) => {
      const text = el.textContent?.toLowerCase() ?? '';
      el.style.display = q === '' || text.includes(q) ? '' : 'none';
    });
  });

  const titleInput = container.querySelector<HTMLInputElement>('[data-testid="note-title"]');
  const tagsInput = container.querySelector<HTMLInputElement>('[data-testid="note-tags"]');
  const bodyInput = container.querySelector<HTMLTextAreaElement>('[data-testid="note-body"]');
  const preview = container.querySelector<HTMLElement>('[data-testid="note-preview"]');

  let saveTimer: number | undefined;
  const scheduleSave = (): void => {
    if (selectedId === undefined || !titleInput || !tagsInput || !bodyInput) return;
    saveIndicator('saving…');
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const tags = tagsInput.value
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const updated = notesStore.update(selectedId!, { title: titleInput.value, body: bodyInput.value, tags });
      if (updated) announceEditing(updated);
      saveIndicator('saved');
      // Re-render the list (titles/timestamps changed) without stealing focus from the editor.
      const list = container?.querySelector('[data-testid="note-list"]');
      if (list) list.innerHTML = renderList();
      container?.querySelectorAll<HTMLElement>('[data-note-id]').forEach((el) => {
        el.addEventListener('click', () => {
          selectedId = el.dataset.noteId;
          render();
        });
      });
    }, 250);
  };

  bodyInput?.addEventListener('input', () => {
    if (preview) preview.innerHTML = renderMarkdown(bodyInput.value);
    scheduleSave();
  });
  titleInput?.addEventListener('input', scheduleSave);
  tagsInput?.addEventListener('input', scheduleSave);

  container.querySelector('[data-testid="note-delete"]')?.addEventListener('click', () => {
    if (selectedId === undefined) return;
    notesStore.remove(selectedId);
    getClient()?.event('note_deleted');
    selectedId = undefined;
    render();
  });

  container.querySelector('[data-testid="note-suggest-prompt"]')?.addEventListener('click', () => {
    void fetch('/api/prompt')
      .then((r) => r.json())
      .then((data: { prompt: string }) => {
        if (bodyInput && selectedId !== undefined) {
          bodyInput.value = `${bodyInput.value}\n\n> ${data.prompt}`;
          if (preview) preview.innerHTML = renderMarkdown(bodyInput.value);
          scheduleSave();
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('prompt suggestion failed', err);
      });
  });

  container.querySelector('[data-testid="note-backup"]')?.addEventListener('click', () => {
    const notes = notesStore.list();
    void fetch('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    })
      .then((r) => r.json())
      .then((data: { ok: boolean; count: number }) => {
        getClient()?.event('notes_backed_up', { count: data.count });
        saveIndicator(`backed up ${data.count} notes`);
      })
      .catch((err) => {
        getClient()?.logException(err, { labels: ['notes-app', 'backup-failed'] });
      });
  });
}

export function mountNotesApp(el: HTMLElement): void {
  container = el;
  connectPresence();
  const first = notesStore.list()[0];
  selectedId = first?.id;
  render();
}
