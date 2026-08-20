<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router';
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <RouterLink to="/" class="brand">📖 Recipe Book</RouterLink>
      <nav>
        <RouterLink to="/">Recipes</RouterLink>
        <RouterLink to="/favourites">Favourites</RouterLink>
        <RouterLink to="/recipes/new">New recipe</RouterLink>
        <RouterLink to="/scenarios">Scenario panel</RouterLink>
      </nav>
    </header>
    <main class="content">
      <RouterView />
    </main>
  </div>
</template>

<style>
  :root {
    color-scheme: light;
    --ink: #2b2118;
    --paper: #fdfaf5;
    --accent: #c1440e;
    --border: #e4d9c8;
  }
  * {
    box-sizing: border-box;
  }
  body {
    margin: 0;
    font-family:
      ui-sans-serif,
      system-ui,
      -apple-system,
      'Segoe UI',
      sans-serif;
    background: var(--paper);
    color: var(--ink);
  }
  a {
    color: var(--accent);
  }
  .app-shell {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--border);
    background: white;
  }
  .brand {
    font-weight: 700;
    font-size: 1.1rem;
    text-decoration: none;
    color: var(--ink);
  }
  .topbar nav {
    display: flex;
    gap: 1.25rem;
  }
  .topbar nav a {
    text-decoration: none;
    color: var(--ink);
    font-size: 0.95rem;
  }
  .topbar nav a.router-link-exact-active {
    color: var(--accent);
    font-weight: 600;
  }
  .content {
    flex: 1;
    padding: 1.5rem;
    max-width: 960px;
    width: 100%;
    margin: 0 auto;
  }
  button {
    font: inherit;
    cursor: pointer;
  }
</style>
