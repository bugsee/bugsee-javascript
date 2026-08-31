import './styles.css';
import { launchApp } from './bugsee';
import { mountNotesApp } from './notes-app';
import { mountScenarioPanel } from './scenarios';

launchApp();

const appRoot = document.getElementById('app');
if (appRoot === null) throw new Error('#app root missing from index.html');

function renderNav(route: string): string {
  return `
    <nav class="top-nav">
      <span class="brand">Markdown Notes</span>
      <a href="#/" class="${route === '' || route === '/' ? 'active' : ''}">Notes</a>
      <a href="#/scenarios" class="${route === '/scenarios' ? 'active' : ''}">Scenarios</a>
    </nav>
    <div id="view"></div>`;
}

function renderRoute(): void {
  const route = location.hash.replace(/^#/, '');
  appRoot!.innerHTML = renderNav(route);
  const view = document.getElementById('view')!;
  if (route === '/scenarios') {
    mountScenarioPanel(view);
  } else {
    mountNotesApp(view);
  }
}

window.addEventListener('hashchange', renderRoute);
renderRoute();
