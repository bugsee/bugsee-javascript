import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useParams } from 'react-router-dom';
import { BugseeProfiler } from '@bugsee/react';
import { api } from '../api/client';
import type { BoardDetail, Card } from '../types';
import ListColumn from '../components/ListColumn';
import ActivityFeed, { type ActivityFeedHandle } from '../components/ActivityFeed';

export default function BoardPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [board, setBoard] = useState<BoardDetail | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [draggingCardId, setDraggingCardId] = useState<string | undefined>(undefined);
  const [newListTitle, setNewListTitle] = useState('');
  const feedRef = useRef<ActivityFeedHandle>(null);

  const load = useCallback(() => {
    if (!id) return;
    api
      .getBoard(id)
      .then(setBoard)
      .catch((e) => setError(String(e)));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function moveCard(listId: string): Promise<void> {
    if (!draggingCardId || !board) return;
    const card = board.cards.find((c) => c.id === draggingCardId);
    if (!card || card.listId === listId) {
      setDraggingCardId(undefined);
      return;
    }
    // Optimistic update: move it locally first, PATCH in the background, roll back on failure — the
    // app-concept requirement ("optimistic updates against a small local API").
    const previous = board;
    setBoard({
      ...board,
      cards: board.cards.map((c) => (c.id === card.id ? { ...c, listId } : c)),
    });
    setDraggingCardId(undefined);
    try {
      await api.updateCard(card.id, { listId });
      feedRef.current?.broadcast(`moved "${card.title}" to a new list`);
    } catch (e) {
      setBoard(previous); // rollback
      setError(`Move failed, rolled back: ${String(e)}`);
    }
  }

  async function createCard(listId: string, title: string): Promise<void> {
    if (!board) return;
    const optimisticId = `optimistic-${Date.now()}`;
    const optimistic: Card = {
      id: optimisticId,
      listId,
      boardId: board.id,
      title,
      description: '',
      labels: [],
      order: board.cards.filter((c) => c.listId === listId).length,
      createdAt: Date.now(),
    };
    setBoard({ ...board, cards: [...board.cards, optimistic] });
    try {
      const real = await api.createCard(board.id, listId, title);
      setBoard((prev) =>
        prev
          ? { ...prev, cards: prev.cards.map((c) => (c.id === optimisticId ? real : c)) }
          : prev,
      );
      feedRef.current?.broadcast(`added card "${title}"`);
    } catch (e) {
      setBoard((prev) => (prev ? { ...prev, cards: prev.cards.filter((c) => c.id !== optimisticId) } : prev));
      setError(`Create failed, rolled back: ${String(e)}`);
    }
  }

  async function createList(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!board || newListTitle.trim() === '') return;
    const list = await api.createList(board.id, newListTitle.trim());
    setBoard({ ...board, lists: [...board.lists, list] });
    setNewListTitle('');
  }

  if (error && !board) return <p className="status-line err">{error}</p>;
  if (!board) return <p>Loading board…</p>;

  return (
    <div>
      <div className="board-header">
        <h2>{board.title}</h2>
      </div>
      {error && <p className="status-line err">{error}</p>}
      {/* BugseeProfiler under test: records a ui.render child span on the active transaction for each
          commit of the lists row (see @bugsee/react's file-header caveat: only live in a build that
          bundles react-dom/profiling, which vite.config.ts does not alias — this still exercises the
          fallback post-commit measurement path, which self-detects and never needs that alias). */}
      <BugseeProfiler id="BoardLists">
        <div className="lists-row">
          {board.lists
            .sort((a, b) => a.order - b.order)
            .map((list) => (
              <ListColumn
                key={list.id}
                list={list}
                boardId={board.id}
                cards={board.cards.filter((c) => c.listId === list.id)}
                draggingCardId={draggingCardId}
                onDragStart={(c) => setDraggingCardId(c.id)}
                onDragEnd={() => setDraggingCardId(undefined)}
                onDrop={moveCard}
                onCreateCard={createCard}
              />
            ))}
          <form className="new-card-form" onSubmit={createList} style={{ width: 220 }}>
            <input
              value={newListTitle}
              onChange={(e) => setNewListTitle(e.target.value)}
              placeholder="+ Add list"
              data-testid="new-list-input"
            />
          </form>
        </div>
      </BugseeProfiler>
      <div style={{ marginTop: 24, maxWidth: 320 }}>
        <ActivityFeed ref={feedRef} />
      </div>
      <Outlet context={{ board, reload: load }} />
    </div>
  );
}
