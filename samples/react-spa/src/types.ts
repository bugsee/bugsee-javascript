export interface Board {
  id: string;
  title: string;
  createdAt: number;
}

export interface List {
  id: string;
  boardId: string;
  title: string;
  order: number;
}

export interface Card {
  id: string;
  listId: string;
  boardId: string;
  title: string;
  description: string;
  order: number;
  labels: string[];
  createdAt: number;
}

export interface BoardDetail extends Board {
  lists: List[];
  cards: Card[];
}
