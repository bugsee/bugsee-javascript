<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { Recipe } from '../data/recipes';
import { useFavouritesStore } from '../stores/favourites';

defineProps<{ recipe: Recipe }>();
const favourites = useFavouritesStore();
</script>

<template>
  <article class="card">
    <RouterLink :to="`/recipes/${recipe.id}`" class="card-link">
      <img :src="recipe.image" :alt="recipe.title" loading="lazy" />
      <div class="card-body">
        <h3>{{ recipe.title }}</h3>
        <p>{{ recipe.description }}</p>
        <div class="tags">
          <span v-for="tag in recipe.tags" :key="tag" class="tag">{{ tag }}</span>
        </div>
      </div>
    </RouterLink>
    <button
      class="fav-toggle"
      :class="{ active: favourites.isFavourite(recipe.id) }"
      :aria-label="favourites.isFavourite(recipe.id) ? 'Remove favourite' : 'Add favourite'"
      @click="favourites.toggle(recipe.id)"
    >
      {{ favourites.isFavourite(recipe.id) ? '♥' : '♡' }}
    </button>
  </article>
</template>

<style scoped>
  .card {
    position: relative;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    background: white;
  }
  .card-link {
    text-decoration: none;
    color: inherit;
    display: block;
  }
  .card img {
    width: 100%;
    height: 140px;
    object-fit: cover;
    display: block;
    background: var(--border);
  }
  .card-body {
    padding: 0.85rem 1rem 1rem;
  }
  .card-body h3 {
    margin: 0 0 0.35rem;
    font-size: 1.05rem;
  }
  .card-body p {
    margin: 0 0 0.6rem;
    font-size: 0.88rem;
    color: #6b6053;
  }
  .tags {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .tag {
    font-size: 0.72rem;
    background: #f3ece0;
    border-radius: 999px;
    padding: 0.15rem 0.55rem;
    color: #8a7a5f;
  }
  .fav-toggle {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    background: rgba(255, 255, 255, 0.9);
    border: none;
    border-radius: 50%;
    width: 2rem;
    height: 2rem;
    font-size: 1.1rem;
    line-height: 1;
  }
  .fav-toggle.active {
    color: var(--accent);
  }
</style>
