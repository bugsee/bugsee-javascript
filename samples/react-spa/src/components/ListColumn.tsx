import { useState } from 'react';
import type { Card, List } from '../types';
import CardTile from './CardTile';

interface Props {
  list: List;
  boardId: string;
  cards: Card[];
  draggingCardId: string | undefined;
  onDragStart: (card: Card) => void;
  onDragEnd: () => void;
  onDrop: (listId: string) => void;
  onCreateCard: (listId: string, title: string) => void;
}

export default function ListColumn({
  list,
  boardId,
  cards,
  draggingCardId,
  onDragStart,
  onDragEnd,
  onDrop,
  onCreateCard,
}: Props): JSX.Element {
  const [over, setOver] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  return (
    <div
      className={`list-column${over ? ' drag-over' : ''}`}
      data-testid={`list-${list.id}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDrop(list.id);
      }}
    >
      <h4>
        {list.title} <span>{cards.length}</span>
      </h4>
      {cards
        .sort((a, b) => a.order - b.order)
        .map((c) => (
          <CardTile
            key={c.id}
            card={c}
            boardId={boardId}
            dragging={draggingCardId === c.id}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
      <form
        className="new-card-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (newTitle.trim() === '') return;
          onCreateCard(list.id, newTitle.trim());
          setNewTitle('');
        }}
      >
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="+ Add card"
          data-testid={`new-card-input-${list.id}`}
        />
      </form>
    </div>
  );
}
