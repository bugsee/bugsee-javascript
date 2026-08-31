<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../api/client';
  import HeatMap from '../components/HeatMap.svelte';
  import { navigate } from '../router.svelte';
  import type { Habit } from '../types';

  let { id }: { id: string } = $props();

  let habit = $state<Habit | undefined>(undefined);
  let notFound = $state(false);

  async function load(): Promise<void> {
    notFound = false;
    try {
      habit = await api.getHabit(id);
    } catch {
      notFound = true;
    }
  }

  onMount(load);
  $effect(() => {
    // Re-load when the route param changes (navigating from one habit to another).
    void id;
    load();
  });

  async function toggle(date: string): Promise<void> {
    if (!habit) return;
    habit = await api.toggleCheckin(habit.id, date);
  }

  async function remove(): Promise<void> {
    if (!habit) return;
    await api.deleteHabit(habit.id);
    navigate('/habits');
  }
</script>

{#if notFound}
  <p data-testid="habit-not-found">No such habit.</p>
{:else if habit}
  <h2>{habit.name}</h2>
  <p class="pill">{habit.category}</p>
  <p class="status-line">
    current streak: {habit.currentStreak} · longest streak: {habit.longestStreak} · target: {habit.targetPerWeek}/week
  </p>
  <div class="card">
    <h3>Last 12 weeks</h3>
    <HeatMap checkins={habit.checkins} color={habit.color} ontoggle={toggle} testid="habit-heatmap" />
  </div>
  <button class="danger" data-testid="delete-habit" onclick={remove}>Delete habit</button>
{:else}
  <p>Loading…</p>
{/if}
