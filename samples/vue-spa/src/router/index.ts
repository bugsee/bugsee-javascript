import { createRouter, createWebHistory } from 'vue-router';
import { instrumentVueRouter } from '@bugsee/vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'recipe-list', component: () => import('../views/RecipeList.vue') },
    { path: '/favourites', name: 'favourites', component: () => import('../views/Favourites.vue') },
    { path: '/recipes/new', name: 'recipe-new', component: () => import('../views/RecipeEditor.vue') },
    {
      path: '/recipes/:id',
      name: 'recipe-detail',
      component: () => import('../views/RecipeDetail.vue'),
      props: true,
    },
    {
      path: '/recipes/:id/edit',
      name: 'recipe-edit',
      component: () => import('../views/RecipeEditor.vue'),
      props: true,
    },
    { path: '/scenarios', name: 'scenarios', component: () => import('../views/Scenarios.vue') },
  ],
});

// @bugsee/vue router naming (S9 route naming + the vue-spa "beyond the catalog" item): every navigation
// transaction gets refined from the raw URL to the matched route PATTERN — `/recipes/:id`, never
// `/recipes/tomato-basil-soup`. Call once, here, right after createRouter().
instrumentVueRouter(router);

export default router;
