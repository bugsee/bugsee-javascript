<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../api/client';
  import HeatMap from '../components/HeatMap.svelte';
  import type { Habit } from '../types';

  let habits = $state<Habit[]>([]);
  let selectedId = $state<string>('');

  onMount(async () => {
    habits = await api.listHabits();
    selectedId = habits[0]?.id ?? '';
  });

  const selected = $derived(habits.find((h) => h.id === selectedId));

  async function toggle(date: string): Promise<void> {
    if (!selected) return;
    const updated = await api.toggleCheckin(selected.id, date);
    habits = habits.map((h) => (h.id === updated.id ? updated : h));
  }
</script>

<h2>Calendar heat map</h2>

<div class="row" style="margin-bottom:1rem;">
  <select data-testid="calendar-habit-select" bind:value={selectedId}>
    {#each habits as h (h.id)}
      <option value={h.id}>{h.name}</option>
    {/each}
  </select>
</div>

{#if selected}
  <div class="card">
    <HeatMap checkins={selected.checkins} color={selected.color} ontoggle={toggle} testid="calendar-heatmap" />
  </div>
{:else}
  <p>Loading…</p>
{/if}
