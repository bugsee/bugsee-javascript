<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../api/client';
  import HabitTile from '../components/HabitTile.svelte';
  import type { Habit } from '../types';

  let habits = $state<Habit[]>([]);
  let loading = $state(true);
  let name = $state('');
  let category = $state('health');
  let color = $state('#22d3ee');
  let targetPerWeek = $state(5);

  async function load(): Promise<void> {
    loading = true;
    habits = await api.listHabits();
    loading = false;
  }

  onMount(load);

  async function addHabit(e: Event): Promise<void> {
    e.preventDefault();
    if (name.trim() === '') return;
    const created = await api.createHabit({ name, category, color, targetPerWeek });
    habits = [...habits, created];
    name = '';
  }

  async function toggleToday(id: string): Promise<void> {
    // Optimistic toggle, like react-spa's card edits — then reconcile with the server response.
    const today = new Date().toISOString().slice(0, 10);
    habits = habits.map((h) =>
      h.id === id
        ? {
            ...h,
            checkins: h.checkins.includes(today)
              ? h.checkins.filter((d) => d !== today)
              : [...h.checkins, today].sort(),
          }
        : h,
    );
    const updated = await api.toggleCheckin(id, today);
    habits = habits.map((h) => (h.id === id ? updated : h));
  }
</script>

<h2>Habits</h2>

{#if loading}
  <p>Loading…</p>
{:else}
  {#each habits as habit (habit.id)}
    <HabitTile {habit} ontoggletoday={toggleToday} />
  {/each}
{/if}

<form class="card" onsubmit={addHabit}>
  <h3>Add a habit</h3>
  <div class="scenario-section" style="border:none;padding:0;margin:0;">
    <div class="row">
      <input data-testid="new-habit-name" placeholder="Name" bind:value={name} />
      <select data-testid="new-habit-category" bind:value={category}>
        <option value="health">health</option>
        <option value="mind">mind</option>
        <option value="work">work</option>
      </select>
      <input data-testid="new-habit-color" type="color" bind:value={color} />
      <input data-testid="new-habit-target" type="number" min="1" max="7" bind:value={targetPerWeek} />
      <button class="primary" type="submit" data-testid="add-habit">Add</button>
    </div>
  </div>
</form>
