<script setup lang="ts">
// An async component (`async setup()`), meant to be used inside a <Suspense> boundary. Computes a fake
// nutrition estimate from the recipe's ingredient count after a real await — exercising Vue's async
// component / Suspense error surface when `shouldThrow` is set (see src/components/ErrorLab.vue, the
// "async-component/Suspense error" scenario in docs/samples/PLAN.md §5.3).
const props = defineProps<{ ingredientCount: number; shouldThrow?: boolean }>();

await new Promise((resolve) => setTimeout(resolve, 120));

if (props.shouldThrow) {
  throw new Error('NutritionPanel: nutrition service unavailable (simulated async-component error)');
}

const estimatedCalories = 80 + props.ingredientCount * 45;
</script>

<template>
  <div class="nutrition">
    <strong>Estimated calories:</strong> ~{{ estimatedCalories }} kcal per serving
  </div>
</template>

<style scoped>
  .nutrition {
    margin-top: 0.75rem;
    padding: 0.6rem 0.85rem;
    background: #f3ece0;
    border-radius: 8px;
    font-size: 0.9rem;
  }
</style>
