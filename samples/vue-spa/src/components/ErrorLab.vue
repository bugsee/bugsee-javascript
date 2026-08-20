<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { reportVueError } from '@bugsee/vue';
import LifecycleBoom from './LifecycleBoom.vue';
import RenderBoom from './RenderBoom.vue';

// One trigger per distinct Vue error surface (docs/samples/PLAN.md §5.3 "beyond the catalog"): a render
// error, a lifecycle-hook error, an event-handler error, a watcher error, an async-component/Suspense
// error (see RecipeDetail.vue + NutritionPanel.vue), and a direct reportVueError() call. Every path is
// wired to the SAME app.config.errorHandler installed in main.ts (installBugseeErrorHandler) except the
// direct call, which bypasses the handler on purpose.

defineOptions({ name: 'ErrorLab' });
const router = useRouter();

// --- render error --- (RenderBoom.vue — isolated so only its own subtree disappears, see that file)
const armRenderError = ref(false);

// --- lifecycle-hook error ---
const mountLifecycleBoom = ref(false);
function triggerLifecycleError(): void {
  mountLifecycleBoom.value = false;
  // Force a fresh mount even if it was already true once (v-if false->true->false->true).
  requestAnimationFrame(() => {
    mountLifecycleBoom.value = true;
  });
}

// --- event-handler error ---
function triggerEventHandlerError(): void {
  throw new Error('ErrorLab: click handler threw directly (simulated event-handler error)');
}

// --- watcher error ---
const watcherArmed = ref(false);
const watcherTick = ref(0);
watch(watcherTick, () => {
  if (watcherArmed.value) {
    watcherArmed.value = false;
    throw new Error('ErrorLab: watcher callback threw (simulated watcher error)');
  }
});
function triggerWatcherError(): void {
  watcherArmed.value = true;
  watcherTick.value += 1;
}

// --- async-component / Suspense error (lives on RecipeDetail + NutritionPanel) ---
function triggerSuspenseError(): void {
  void router.push('/recipes/tomato-basil-soup?nutritionError=1');
}

// --- direct reportVueError() call, bypassing app.config.errorHandler ---
function triggerDirectReport(): void {
  reportVueError(new Error('ErrorLab: reportVueError() called directly'), {
    info: 'manual reportVueError call',
    mechanism: 'programmatic',
  });
}
</script>

<template>
  <div class="error-lab">
    <RenderBoom v-if="armRenderError" />
    <LifecycleBoom v-if="mountLifecycleBoom" />

    <div class="row">
      <button @click="armRenderError = true">Render error</button>
      <button @click="triggerLifecycleError">Lifecycle-hook error</button>
      <button @click="triggerEventHandlerError">Event-handler error</button>
      <button @click="triggerWatcherError">Watcher error</button>
      <button @click="triggerSuspenseError">Async-component / Suspense error</button>
      <button @click="triggerDirectReport">Direct reportVueError()</button>
    </div>
  </div>
</template>

<style scoped>
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
