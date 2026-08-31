import { mount } from 'svelte';
import App from './App.svelte';
import { launchApp } from './bugsee';
import { initRouter } from './router.svelte';
import './app.css';

// S1: launch() once, at app bootstrap — every scenario after this reads the same client via getClient().
launchApp();
initRouter();

const app = mount(App, { target: document.getElementById('app')! });

export default app;
