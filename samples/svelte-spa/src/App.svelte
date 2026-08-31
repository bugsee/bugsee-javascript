<script lang="ts">
  import { currentRoute } from './router.svelte';
  import { handleAppError } from './bugsee';
  import HabitsIndexPage from './routes/HabitsIndexPage.svelte';
  import HabitDetailPage from './routes/HabitDetailPage.svelte';
  import CalendarPage from './routes/CalendarPage.svelte';
  import StatsPage from './routes/StatsPage.svelte';
  import SettingsPage from './routes/SettingsPage.svelte';
  import ScenarioPage from './routes/ScenarioPage.svelte';
  import NotFoundPage from './routes/NotFoundPage.svelte';

  const route = $derived(currentRoute());

  const links = [
    { href: '#/habits', label: 'Habits', id: '/habits' },
    { href: '#/calendar', label: 'Calendar', id: '/calendar' },
    { href: '#/stats', label: 'Stats', id: '/stats' },
    { href: '#/settings', label: 'Settings', id: '/settings' },
    { href: '#/scenarios', label: 'Scenarios', id: '/scenarios' },
  ];

  // App-level <svelte:boundary> (a Svelte 5 primitive, not @bugsee/svelte's) around the whole route
  // outlet — the "global unguarded throw" analogue of react-spa's app-level BugseeErrorBoundary. Its
  // `onerror` builds the exact `HandleErrorInput` shape SvelteKit's own `handleError` hook would pass
  // (`{ error, event: { route: { id } } }`) by hand, then routes it through the @bugsee/svelte seam.
  function onBoundaryError(error: unknown): void {
    handleAppError({ error, event: { route: { id: route.id } } });
  }
</script>

<div class="app-shell">
  <nav class="side-nav">
    <h1>Habitbugsee</h1>
    {#each links as link (link.id)}
      <a
        href={link.href}
        class={route.id === link.id ? 'active' : ''}
        data-testid={`nav-${link.label.toLowerCase()}`}
      >
        {link.label}
      </a>
    {/each}
  </nav>
  <main class="content">
    <svelte:boundary onerror={onBoundaryError}>
      {#if route.id === '/habits'}
        <HabitsIndexPage />
      {:else if route.id === '/habits/[id]'}
        <HabitDetailPage id={route.params.id} />
      {:else if route.id === '/calendar'}
        <CalendarPage />
      {:else if route.id === '/stats'}
        <StatsPage />
      {:else if route.id === '/settings'}
        <SettingsPage />
      {:else if route.id === '/scenarios'}
        <ScenarioPage />
      {:else}
        <NotFoundPage />
      {/if}
      {#snippet failed(error, reset)}
        <div class="card" data-testid="error-fallback">
          <h3>Something broke</h3>
          <p>{(error as Error)?.message ?? String(error)}</p>
          <button onclick={reset} data-testid="error-fallback-reset">Reset</button>
        </div>
      {/snippet}
    </svelte:boundary>
  </main>
</div>
