<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../api/client';
  import type { Habit } from '../types';

  let habits = $state<Habit[]>([]);

  onMount(async () => {
    habits = await api.listHabits();
  });

  function completionRate(h: Habit): number {
    const last28 = Array.from({ length: 28 }, (_, i) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      return d.toISOString().slice(0, 10);
    });
    const done = last28.filter((d) => h.checkins.includes(d)).length;
    return Math.round((done / 28) * 100);
  }
</script>

<h2>Streak stats</h2>

<table class="card" style="width:100%; border-collapse:collapse;" data-testid="stats-table">
  <thead>
    <tr>
      <th style="text-align:left;">Habit</th>
      <th>Current streak</th>
      <th>Longest streak</th>
      <th>28-day rate</th>
    </tr>
  </thead>
  <tbody>
    {#each habits as h (h.id)}
      <tr data-testid={`stats-row-${h.id}`}>
        <td>{h.name}</td>
        <td style="text-align:center;">{h.currentStreak}</td>
        <td style="text-align:center;">{h.longestStreak}</td>
        <td style="text-align:center;">{completionRate(h)}%</td>
      </tr>
    {/each}
  </tbody>
</table>
