<script lang="ts">
  // Throws when armed — the target for the `<svelte:boundary>` wired in App.svelte / ScenarioPage.svelte,
  // which reports it via @bugsee/svelte's `handleErrorWithBugsee` seam. A Svelte 5 `<svelte:boundary>`
  // catches errors thrown during component initialization AND inside `$effect` (not event handlers /
  // timers), so the throw is wrapped in an effect: it re-runs reactively when `armed` flips true on an
  // ALREADY-MOUNTED instance (this component is never remounted by its callers — a plain prop toggle),
  // whereas a top-level `if (armed) throw` in the instance script only ever evaluates once, at init.
  // `scenario` gives the local and global callers DISTINCT messages, so an individual captured EVENT is
  // self-describing about which boundary fired it.
  //
  // It does NOT split them into separate ISSUES, and an earlier version of this comment wrongly claimed
  // it did. Checked at the backend: both paths still fingerprint to ONE issue (`SSVELTE-108` at the time
  // of writing — the key is RE-MINTED whenever this file shifts, so re-derive rather than trust it; see
  // scenarios.md's fingerprint-churn note and its Svelte-specific row) whose `events_count` grows on
  // every run of both — Bugsee's error grouping keys off the thrown Error's own stack, which originates
  // at the same `$effect` line below whichever boundary catches it, not off the message text.
  let { armed = false, scenario = 'local' }: { armed?: boolean; scenario?: 'local' | 'global' } = $props();

  $effect(() => {
    if (armed) {
      throw new Error(`S-svelte: ThrowingWidget ${scenario}-boundary render throw (caught by <svelte:boundary>)`);
    }
  });
</script>

<div class="card" data-testid="guarded-widget">Guarded widget rendered without throwing.</div>
