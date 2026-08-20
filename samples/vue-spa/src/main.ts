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
// itself does during boot (S1).
launchBugsee();

const app = createApp(App);

// The Vue error seam (S4/S5 + the vue-spa "beyond the catalog" items): app.config.errorHandler catches
// render errors, lifecycle-hook errors, event-handler errors, watcher errors, and (unhandled) async
// component/Suspense errors — see src/components/ErrorLab.vue for one trigger per surface.
//
// The `as unknown as VueAppLike` cast is required: a REAL `createApp()` App's `config.errorHandler`
// is typed `(err, instance: ComponentPublicInstance | null, info) => void`, which is not assignable to
// VueAppLike's `(err, instance: unknown, info) => void` under strictFunctionTypes (contravariant
// parameter check — `unknown` is not assignable to `ComponentPublicInstance | null`). Calling
// installBugseeErrorHandler(app) with a genuine Vue app, exactly as the package doc comment shows,
// does not typecheck without this cast — see samples/vue-spa/FINDINGS.md.
installBugseeErrorHandler(app as unknown as VueAppLike);

// Component attribution (data-bugsee-component on every mounted/updated component's root element) +
// render spans (a ui.render child span per mount/update on the active transaction).
app.mixin(createBugseeVueComponentMixin());
app.mixin(createBugseeVueRenderMixin());

app.use(createPinia());
app.use(router);

app.mount('#app');
