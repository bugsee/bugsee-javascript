import { Link } from 'react-router-dom';
import type { Card } from '../types';

interface Props {
  card: Card;
  boardId: string;
  dragging: boolean;
  onDragStart: (card: Card) => void;
  onDragEnd: () => void;
}

export default function CardTile({ card, boardId, dragging, onDragStart, onDragEnd }: Props): JSX.Element {
  return (
    <div
      className={`card-tile${dragging ? ' dragging' : ''}`}
      draggable
      onDragStart={() => onDragStart(card)}
      onDragEnd={onDragEnd}
      data-testid={`card-${card.id}`}
    >
      <Link to={`/board/${boardId}/card/${card.id}`}>{card.title}</Link>
      {card.labels.length > 0 && (
        <div>
          {card.labels.map((l) => (
            <span key={l} className="pill">
              {l}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
