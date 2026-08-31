export type ExpenseStatus = 'pending' | 'approved' | 'rejected';

export interface ExpenseAttachment {
  name: string;
  mimeType: string;
  size: number;
  dataBase64: string;
}

export interface Expense {
  id: string;
  title: string;
  amount: number;
  category: string;
  date: string;
  notes: string;
  status: ExpenseStatus;
  attachment: ExpenseAttachment | null;
  createdAt: number;
}

export interface NewExpenseInput {
  title: string;
  amount: number;
  category: string;
  date: string;
  notes: string;
  attachment: ExpenseAttachment | null;
}

export interface ActivityEntry {
  type: string;
  id: string;
  title: string;
  at: number;
}
