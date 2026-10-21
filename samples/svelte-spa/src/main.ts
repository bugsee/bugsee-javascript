import { mount } from 'svelte';
import App from './App.svelte';
import { launchApp } from './bugsee';
import { initRouter } from './router.svelte';
import './app.css';

// launch() once, at app bootstrap — every scenario after this reads the same client via getClient().
// launch() is async (it restores durable state before it resolves): boot only once the client is up.
async function boot(): Promise<void> {
  await launchApp();
  initRouter();

  mount(App, { target: document.getElementById('app')! });
}

void boot();
