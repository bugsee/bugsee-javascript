<script lang="ts">
  import type { Habit } from '../types';

  let {
    habit,
    ontoggletoday,
  }: {
    habit: Habit;
    ontoggletoday: (id: string) => void;
  } = $props();

  const today = new Date().toISOString().slice(0, 10);
  const doneToday = $derived(habit.checkins.includes(today));
</script>

<div class="card habit-tile" data-testid={`habit-tile-${habit.id}`}>
  <div>
    <span class="swatch" style={`background:${habit.color}`}></span>
    <a href={`#/habits/${habit.id}`} data-testid={`habit-link-${habit.id}`}>{habit.name}</a>
    <span class="pill">{habit.category}</span>
    <div class="status-line">
      streak {habit.currentStreak} · longest {habit.longestStreak} · target {habit.targetPerWeek}/wk
    </div>
  </div>
  <button
    class={doneToday ? 'primary' : ''}
    data-testid={`toggle-today-${habit.id}`}
    onclick={() => ontoggletoday(habit.id)}
  >
    {doneToday ? 'Done today' : 'Mark today'}
  </button>
</div>
