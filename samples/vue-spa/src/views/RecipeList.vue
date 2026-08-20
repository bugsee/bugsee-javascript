<script setup lang="ts">
import { onMounted } from 'vue';
import RecipeCard from '../components/RecipeCard.vue';
import { useRecipesStore } from '../stores/recipes';

const store = useRecipesStore();
onMounted(() => {
  void store.fetchAll();
});
</script>

<template>
  <section>
    <h1>Recipes</h1>
    <p v-if="store.loading">Loading recipes…</p>
    <p v-else-if="store.error" class="error">Could not load recipes: {{ store.error }}</p>
    <div v-else class="grid">
      <RecipeCard v-for="recipe in store.recipes" :key="recipe.id" :recipe="recipe" />
    </div>
  </section>
</template>

<style scoped>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 1rem;
  }
  .error {
    color: #a3241a;
  }
</style>
