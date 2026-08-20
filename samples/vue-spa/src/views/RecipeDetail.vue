<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import NutritionPanel from '../components/NutritionPanel.vue';
import { useFavouritesStore } from '../stores/favourites';
import { useRecipesStore } from '../stores/recipes';

const props = defineProps<{ id: string }>();
const store = useRecipesStore();
const favourites = useFavouritesStore();
const router = useRouter();
const notFound = ref(false);

// Read once per mount; the Scenario panel can navigate here with ?nutritionError=1 to arm the async
// Suspense-error scenario for this recipe (S14 vue-spa: async-component/Suspense error).
const shouldThrowNutrition = computed(() => router.currentRoute.value.query.nutritionError === '1');

onMounted(async () => {
  const recipe = await store.fetchOne(props.id);
  notFound.value = recipe === null;
});

const recipe = computed(() => store.byId(props.id));
</script>

<template>
  <section v-if="notFound">
    <h1>Recipe not found</h1>
    <p><RouterLink to="/">Back to all recipes</RouterLink></p>
  </section>
  <section v-else-if="recipe" class="detail">
    <RouterLink to="/">&larr; All recipes</RouterLink>
    <div class="header">
      <h1>{{ recipe.title }}</h1>
      <button class="fav-toggle" @click="favourites.toggle(recipe.id)">
        {{ favourites.isFavourite(recipe.id) ? '♥ Favourited' : '♡ Add to favourites' }}
      </button>
    </div>
    <img :src="recipe.image" :alt="recipe.title" />
    <p>{{ recipe.description }}</p>
    <p class="meta">⏱ {{ recipe.cookTimeMinutes }} min</p>

    <Suspense>
      <NutritionPanel :ingredient-count="recipe.ingredients.length" :should-throw="shouldThrowNutrition" />
      <template #fallback>
        <div class="nutrition-loading">Estimating nutrition…</div>
      </template>
    </Suspense>

    <h2>Ingredients</h2>
    <ul>
      <li v-for="ingredient in recipe.ingredients" :key="ingredient">{{ ingredient }}</li>
    </ul>

    <h2>Steps</h2>
    <ol>
      <li v-for="(step, i) in recipe.steps" :key="i">{{ step }}</li>
    </ol>

    <p><RouterLink :to="`/recipes/${recipe.id}/edit`">Edit this recipe</RouterLink></p>
  </section>
  <section v-else>
    <p>Loading…</p>
  </section>
</template>

<style scoped>
  .detail img {
    width: 100%;
    max-height: 320px;
    object-fit: cover;
    border-radius: 10px;
    margin: 0.75rem 0;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .fav-toggle {
    background: white;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.4rem 0.9rem;
  }
  .meta {
    color: #6b6053;
  }
  .nutrition-loading {
    margin-top: 0.75rem;
    font-size: 0.9rem;
    color: #6b6053;
  }
</style>
