import { fetchProducts } from '../lib/api';
import { getCart, removeFromCart, setQty } from '../lib/cart';
import { computeDiscount } from '../lib/worker-client';
import { getClient } from '../bugsee-client';

export async function renderCart(container: HTMLElement): Promise<void> {
  container.innerHTML = '<p>Loading cart…</p>';
  const [products, lines] = await Promise.all([fetchProducts(), Promise.resolve(getCart())]);

  if (lines.length === 0) {
    container.innerHTML = `<section class="block"><h1>Cart</h1><p>Your cart is empty. <a href="#/">Browse widgets</a>.</p></section>`;
    return;
  }

  const rows = lines
    .map((line) => {
      const p = products.find((pp) => pp.id === line.id);
      if (p === undefined) return '';
      return `<tr data-line="${line.id}">
        <td>${p.name}</td>
        <td>$${p.price.toFixed(2)}</td>
        <td><input type="number" min="0" value="${line.qty}" data-qty="${line.id}" style="width:4em" /></td>
        <td>$${(p.price * line.qty).toFixed(2)}</td>
        <td><button class="secondary" data-remove="${line.id}">Remove</button></td>
      </tr>`;
    })
    .join('');

  container.innerHTML = `
    <section class="block">
      <h1>Cart</h1>
      <table class="scenario-table">
        <thead><tr><th>Item</th><th>Price</th><th>Qty</th><th>Subtotal</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p><button id="discount">Compute 10% bundle discount (Web Worker)</button></p>
      <p id="discount-result" class="muted"></p>
      <p><a href="#/checkout"><button>Checkout</button></a></p>
    </section>
  `;

  container.querySelectorAll<HTMLInputElement>('input[data-qty]').forEach((input) => {
    input.addEventListener('change', () => {
      const id = input.dataset.qty;
      if (id === undefined) return;
      setQty(id, Number(input.value));
      void renderCart(container);
    });
  });
  container.querySelectorAll<HTMLButtonElement>('button[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.remove;
      if (id === undefined) return;
      removeFromCart(id);
      void renderCart(container);
    });
  });

  container.querySelector('#discount')?.addEventListener('click', async () => {
    const prices = lines
      .map((l) => products.find((p) => p.id === l.id)?.price)
      .filter((p): p is number => p !== undefined);
    const resultEl = container.querySelector('#discount-result') as HTMLElement;
    resultEl.textContent = 'Computing in worker…';
    const { discounted, total } = await computeDiscount(prices, 10);
    resultEl.textContent = `Discounted line prices: ${discounted.map((d) => `$${d}`).join(', ')} — total $${total}`;
    getClient()?.trace('cart.discount.total', total);
  });
}
