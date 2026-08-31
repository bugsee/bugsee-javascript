<script lang="ts">
  let {
    checkins,
    color = '#22d3ee',
    weeks = 12,
    ontoggle,
    testid = 'heatmap',
  }: {
    checkins: string[];
    color?: string;
    weeks?: number;
    ontoggle?: (date: string) => void;
    testid?: string;
  } = $props();

  const checkinSet = $derived(new Set(checkins));

  function isoDaysAgo(n: number): string {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  }

  // Oldest-first, grouped into columns of 7 (a week each) so CSS grid-auto-flow: column reads left→right
  // as time passing, like GitHub's contribution graph.
  const days = $derived(
    Array.from({ length: weeks * 7 }, (_, i) => isoDaysAgo(weeks * 7 - 1 - i)),
  );
</script>

<div class="heatmap" data-testid={testid}>
  {#each days as day (day)}
    <div
      class="cell"
      data-testid={`${testid}-cell-${day}`}
      title={day}
      style={checkinSet.has(day) ? `background:${color}` : ''}
      role="button"
      tabindex="0"
      onclick={() => ontoggle?.(day)}
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') ontoggle?.(day);
      }}
    ></div>
  {/each}
</div>
