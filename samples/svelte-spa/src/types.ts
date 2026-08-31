export interface Habit {
  id: string;
  name: string;
  category: string;
  color: string;
  targetPerWeek: number;
  createdAt: number;
  checkins: string[]; // YYYY-MM-DD, sorted
  currentStreak: number;
  longestStreak: number;
}
