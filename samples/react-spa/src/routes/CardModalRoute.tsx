import { useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { BoardDetail } from '../types';

interface OutletCtx {
  board: BoardDetail;
  reload: () => void;
}

export default function CardModalRoute(): JSX.Element {
  const { cardId } = useParams<{ cardId: string; id: string }>();
  const navigate = useNavigate();
  const { board, reload } = useOutletContext<OutletCtx>();
  const card = board.cards.find((c) => c.id === cardId);
  const [title, setTitle] = useState(card?.title ?? '');
  const [description, setDescription] = useState(card?.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  if (!card) {
    return (
      <div className="modal-backdrop" onClick={() => navigate(`/board/${board.id}`)}>
        <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
          <p>Card not found.</p>
        </div>
      </div>
    );
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(undefined);
    try {
      await api.updateCard(card!.id, { title, description });
      reload();
      navigate(`/board/${board.id}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    await api.deleteCard(card!.id);
    reload();
    navigate(`/board/${board.id}`);
  }

  return (
    <div className="modal-backdrop" onClick={() => navigate(`/board/${board.id}`)} data-testid="card-modal">
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <h2>Card details</h2>
        <div className="field-row">
          <label htmlFor="card-title">Title</label>
          <input id="card-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field-row">
          <label htmlFor="card-desc">Description</label>
          <textarea
            id="card-desc"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        {error && <p className="status-line err">{error}</p>}
        <div className="control-row">
          <button onClick={save} disabled={saving} data-testid="save-card">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button className="danger" onClick={remove} data-testid="delete-card">
            Delete
          </button>
          <button className="secondary" onClick={() => navigate(`/board/${board.id}`)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
