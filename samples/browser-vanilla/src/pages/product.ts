import { fetchProduct, type Product } from '../lib/api';
import { addToCart } from '../lib/cart';
import { drawSparkline } from '../lib/chart';
import { getClient } from '../bugsee-client';

const GALLERY_EMOJI = ['🖼️', '📷', '🎞️', '🖌️'];

export async function renderProduct(container: HTMLElement, params: Record<string, string>): Promise<void> {
  const id = params.id;
  container.innerHTML = '<p>Loading…</p>';
  const product = await fetchProduct(id);
  if (product === undefined) {
    container.innerHTML = `<section class="block"><h1>Not found</h1><p>No product <code>${id}</code>. <a href="#/">Back to shop</a></p></section>`;
    return;
  }
  getClient()?.addBreadcrumb({
    message: `viewed product ${product.id}`,
    category: 'navigation',
    level: 'info',
    data: { productId: product.id, price: product.price },
  });
  render(container, product);
}

function render(container: HTMLElement, product: Product): void {
  container.innerHTML = `
    <section class="block">
      <a href="#/">&larr; back</a>
      <h1>${product.name}</h1>
      <p class="pill">${product.category}</p>
      <p>${product.description}</p>
      <p style="font-size:1.4em">$${product.price.toFixed(2)} <small class="muted">(${product.stock} in stock)</small></p>
      <button id="add">Add to cart</button>

      <h3 style="margin-top:2rem">Price history</h3>
      <canvas id="sparkline" class="sparkline" width="480" height="120"></canvas>

      <h3 style="margin-top:2rem">Gallery <small class="muted">(canvas-recording / block-media target)</small></h3>
      <div class="gallery">
        ${GALLERY_EMOJI.map((e, i) => `<div class="frame" data-gallery-frame="${i}">${e}</div>`).join('')}
      </div>
    </section>
  `;

  const canvas = container.querySelector('#sparkline') as HTMLCanvasElement;
  drawSparkline(canvas, product.priceHistory);

  container.querySelector('#add')?.addEventListener('click', () => {
    addToCart(product.id);
    getClient()?.event('cart_add', { productId: product.id, from: 'product-detail' });
  });
}
