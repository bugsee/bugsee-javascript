<script setup lang="ts">
import { onMounted } from 'vue';

// Mounted only when armed (see ErrorLab.vue's v-if) so onMounted throwing is a deliberate, one-shot
// scenario trigger, not a permanent crash of the page. Named so its component name is visible on the
// resulting issue via reportVueError's `vue.component:` label.
defineOptions({ name: 'LifecycleBoom' });

onMounted(() => {
  throw new Error('LifecycleBoom: onMounted hook threw (simulated lifecycle-hook error)');
});
</script>

<template>
  <span />
</template>
