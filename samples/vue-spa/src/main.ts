import { createPinia } from 'pinia';
import { createApp } from 'vue';
import {
  createBugseeVueComponentMixin,
  createBugseeVueRenderMixin,
  installBugseeErrorHandler,
  type VueAppLike,
} from '@bugsee/vue';
import App from './App.vue';
import { launchBugsee } from './bugsee';
import router from './router/index';

// Launch BEFORE the app is created: console/network/crash capture must be live for anything the app
// itself does during boot.
// launch() is async (it restores durable state before it resolves): create and mount the app only once it is up.
async function boot(): Promise<void> {
  await launchBugsee();

  const app = createApp(App);

  // The Vue error seam (plus the vue-spa extras): app.config.errorHandler catches
  // render errors, lifecycle-hook errors, event-handler errors, watcher errors, and (unhandled) async
  // component/Suspense errors — see src/components/ErrorLab.vue for one trigger per surface.
  //
  // The `as unknown as VueAppLike` cast is required: a REAL `createApp()` App's `config.errorHandler`
  // is typed `(err, instance: ComponentPublicInstance | null, info) => void`, which is not assignable to
  // VueAppLike's `(err, instance: unknown, info) => void` under strictFunctionTypes (contravariant
  // parameter check — `unknown` is not assignable to `ComponentPublicInstance | null`). Calling
  // installBugseeErrorHandler(app) with a genuine Vue app, exactly as the package doc comment shows,
  // does not typecheck without this cast.
  installBugseeErrorHandler(app as unknown as VueAppLike);

  // Component attribution (data-bugsee-component on every mounted/updated component's root element) +
  // render spans (a ui.render child span per mount/update on the active transaction).
  app.mixin(createBugseeVueComponentMixin());
  app.mixin(createBugseeVueRenderMixin());

  app.use(createPinia());
  app.use(router);

  app.mount('#app');
}

void boot();
