<script setup lang="ts">
import { computed, onMounted } from 'vue';
import RecipeCard from '../components/RecipeCard.vue';
import { useFavouritesStore } from '../stores/favourites';
import { useRecipesStore } from '../stores/recipes';

const recipes = useRecipesStore();
const favourites = useFavouritesStore();
onMounted(() => {
  if (recipes.recipes.length === 0) void recipes.fetchAll();
});
const favouriteRecipes = computed(() => recipes.recipes.filter((r) => favourites.isFavourite(r.id)));
</script>

<template>
  <section>
    <h1>Favourites</h1>
    <p v-if="favouriteRecipes.length === 0">
      No favourites yet — tap the heart on any recipe to save it here (stored in localStorage).
    </p>
    <div v-else class="grid">
      <RecipeCard v-for="recipe in favouriteRecipes" :key="recipe.id" :recipe="recipe" />
    </div>
  </section>
</template>

<style scoped>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 1rem;
  }
</style>
