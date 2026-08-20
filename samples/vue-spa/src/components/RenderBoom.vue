<script setup lang="ts">
import { computed } from 'vue';

// Isolated in its OWN component (not inlined into ErrorLab's template) on purpose: when a render
// function throws, Vue removes that component's own subtree from the DOM — even with
// app.config.errorHandler installed, which observes the error but provides no recovery, matching
// Vue's real (undocumented-as-recovery) behaviour. Keeping the exploding expression in a dedicated leaf
// means only THIS component's (empty) output disappears; the button that armed it lives in the parent
// (ErrorLab.vue) and stays clickable, so the rest of the Scenario panel survives the render error.
defineOptions({ name: 'RenderBoom' });

// A computed (not a plain setup-time throw) so the error fires during RENDER-FUNCTION evaluation
// (Vue's `info` = "render function"), not during `setup()`.
const boom = computed(() => {
  const nothing: { boom: string } | null = null;
  return (nothing as unknown as { boom: string }).boom;
});
</script>

<template>
  <span>{{ boom }}</span>
</template>
