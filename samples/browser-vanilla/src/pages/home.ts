import { fetchProducts } from '../lib/api';
import { addToCart } from '../lib/cart';
import { getClient } from '../bugsee-client';

const EMOJI: Record<string, string> = {
  aurora: '✨',
  basalt: '🪨',
  cobalt: '🔷',
  driftwood: '🪵',
  ember: '🔥',
  fathom: '🌊',
};

export async function renderHome(container: HTMLElement): Promise<void> {
  container.innerHTML = `<section class="block"><h1>Widget Shop</h1><p class="muted">A small, genuinely working shop for demoing the Bugsee browser SDK.</p><div id="grid" class="grid"><p>Loading products…</p></div></section>`;
  const grid = container.querySelector('#grid') as HTMLElement;

  getClient()?.addBreadcrumb({ message: 'viewed home', category: 'navigation', level: 'info' });

  try {
    const products = await fetchProducts();
    grid.innerHTML = products
      .map(
        (p) => `
      <article class="card">
        <div class="product-thumb" style="background:linear-gradient(135deg,#243044,#1a2130)">${EMOJI[p.image] ?? '📦'}</div>
        <h3><a href="#/product/${p.id}">${p.name}</a></h3>
        <p class="pill">${p.category}</p>
        <p>$${p.price.toFixed(2)} · <small class="muted">${p.stock} in stock</small></p>
        <button data-add="${p.id}">Add to cart</button>
      </article>`,
      )
      .join('');
    grid.querySelectorAll<HTMLButtonElement>('button[data-add]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.add;
        if (id === undefined) return;
        addToCart(id);
        getClient()?.event('cart_add', { productId: id, from: 'home' });
        btn.textContent = 'Added ✓';
        setTimeout(() => (btn.textContent = 'Add to cart'), 900);
      });
    });
  } catch (error) {
    grid.innerHTML = `<p style="color:#ff8080">Failed to load products: ${String(error)}</p>`;
  }
}
