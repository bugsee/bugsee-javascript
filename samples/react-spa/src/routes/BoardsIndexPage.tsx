import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Board } from '../types';

export default function BoardsIndexPage(): JSX.Element {
  const [boards, setBoards] = useState<Board[] | undefined>(undefined);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    api.listBoards().then(setBoards).catch((e) => setError(String(e)));
  }, []);

  async function createBoard(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (title.trim() === '') return;
    const board = await api.createBoard(title.trim());
    setBoards((prev) => [...(prev ?? []), board]);
    setTitle('');
  }

  return (
    <div>
      <h2>Boards</h2>
      <form className="new-board-form" onSubmit={createBoard}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New board title"
          data-testid="new-board-title"
        />
        <button type="submit" data-testid="create-board">
          Create board
        </button>
      </form>
      {error && <p className="status-line err">{error}</p>}
      <div className="board-grid">
        {boards?.map((b) => (
          <Link key={b.id} to={`/board/${b.id}`} className="board-tile" data-testid={`board-${b.id}`}>
            <h3>{b.title}</h3>
            <p>Created {new Date(b.createdAt).toLocaleDateString()}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
