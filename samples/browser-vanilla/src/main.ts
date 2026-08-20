import './styles.css';
import { bootstrapBugsee, getClient } from './bugsee-client';
import { registerServiceWorker } from './lib/sw-register';
import { cartCount } from './lib/cart';
import { renderHome } from './pages/home';
import { renderProduct } from './pages/product';
import { renderCart } from './pages/cart';
import { renderCheckout } from './pages/checkout';
import { renderOrders } from './pages/orders';
import { renderChat } from './pages/chat';
import { renderSettings } from './pages/settings';
import { renderScenarios } from './pages/scenarios';

const app = document.getElementById('app') as HTMLElement;

app.innerHTML = `
  <header class="topbar">
    <span class="brand">🧩 Widget Shop</span>
    <a href="#/" data-nav="/">Shop</a>
    <a href="#/cart" data-nav="/cart">Cart<span id="cart-count" class="cart-count">0</span></a>
    <a href="#/chat" data-nav="/chat">Chat</a>
    <a href="#/settings" data-nav="/settings">Settings</a>
    <a href="#/scenarios" data-nav="/scenarios">Scenarios</a>
    <span class="spacer"></span>
    <small class="muted" id="sdk-status">booting…</small>
  </header>
  <main id="main"></main>
`;

const main = document.getElementById('main') as HTMLElement;
const sdkStatus = document.getElementById('sdk-status') as HTMLElement;

function updateCartBadge(): void {
  const el = document.getElementById('cart-count');
  if (el !== null) el.textContent = String(cartCount());
}
window.addEventListener('cart:changed', updateCartBadge);
updateCartBadge();

function setActiveNav(path: string): void {
  document.querySelectorAll('a[data-nav]').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('data-nav') === path);
  });
}

interface Route {
  pattern: RegExp;
  keys: string[];
  render: (container: HTMLElement, params: Record<string, string>) => void | Promise<void>;
}

function route(pattern: string, render: Route['render']): Route {
  const keys: string[] = [];
  const regexSource = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment;
    })
    .join('/');
  return { pattern: new RegExp(`^${regexSource}$`), keys, render };
}

const routes: Route[] = [
  route('/', renderHome),
  route('/product/:id', renderProduct),
  route('/cart', renderCart),
  route('/checkout', renderCheckout),
  route('/orders/:id', renderOrders),
  route('/chat', renderChat),
  route('/settings', renderSettings),
  route('/scenarios', renderScenarios),
];

async function router(): Promise<void> {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  const path = hash.split('?')[0];
  setActiveNav(path === '/' ? '/' : path.split('/').slice(0, 2).join('/'));

  // performanceMonitoring can be toggled off from the Settings page, in which case the extension is
  // never registered and ext('performance') throws — guard rather than assume it is always present.
  try {
    getClient()?.ext('performance').setRouteName(routeNamePattern(path));
  } catch {
    // performance extension not registered (performanceMonitoring: false) — nothing to name.
  }

  for (const r of routes) {
    const match = path.match(r.pattern);
    if (match !== null) {
      const params: Record<string, string> = {};
      r.keys.forEach((key, i) => (params[key] = match[i + 1] ?? ''));
      await r.render(main, params);
      return;
    }
  }
  main.innerHTML = `<section class="block"><h1>Not found</h1><p><a href="#/">Back to shop</a></p></section>`;
}

// Names the current path by its ROUTE PATTERN, never the concrete URL (S9 route naming).
function routeNamePattern(path: string): string {
  if (path.startsWith('/product/')) return '/product/:id';
  if (path.startsWith('/orders/')) return '/orders/:id';
  return path;
}

window.addEventListener('hashchange', () => void router());

void (async () => {
  try {
    await bootstrapBugsee();
    sdkStatus.textContent = 'Bugsee: launched';
  } catch (error) {
    sdkStatus.textContent = `Bugsee: failed to launch (${String(error)})`;
    console.error('Bugsee failed to launch', error);
  }
  registerServiceWorker().catch((error) => console.warn('service worker registration failed', error));
  void router();
})();
