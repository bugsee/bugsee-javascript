import { getCart, clearCart } from '../lib/cart';
import { postCheckout } from '../lib/api';
import { getClient } from '../bugsee-client';

// The checkout form is the masking target for S11: a password field and a credit-card field, both
// real <input>s the replay recorder must mask under the default (fail-closed) `maskAllInputs`.

export function renderCheckout(container: HTMLElement): void {
  const lines = getCart();
  if (lines.length === 0) {
    container.innerHTML = `<section class="block"><h1>Checkout</h1><p>Cart is empty. <a href="#/">Browse widgets</a>.</p></section>`;
    return;
  }

  container.innerHTML = `
    <section class="block">
      <h1>Checkout</h1>
      <form id="checkout-form" class="col" style="max-width:420px">
        <label for="email">Email</label>
        <input id="email" type="email" required value="shopper@example.com" />

        <label for="card">Credit card number</label>
        <input id="card" data-cc="true" type="text" required value="4242 4242 4242 4242" autocomplete="cc-number" />

        <label for="password">Account password</label>
        <input id="password" type="password" required value="hunter2-widget-shop" autocomplete="current-password" />

        <div class="row" style="margin-top:1rem">
          <button type="submit">Place order</button>
          <button type="button" class="secondary" id="fail-checkout">Place order (simulate 500)</button>
        </div>
      </form>
      <p id="checkout-status" class="muted"></p>
    </section>
  `;

  const form = container.querySelector('#checkout-form') as HTMLFormElement;
  const status = container.querySelector('#checkout-status') as HTMLElement;

  const submit = async (simulateServerError: boolean): Promise<void> => {
    const email = (container.querySelector('#email') as HTMLInputElement).value;
    const card = (container.querySelector('#card') as HTMLInputElement).value;
    const password = (container.querySelector('#password') as HTMLInputElement).value;
    status.textContent = 'Placing order…';
    try {
      const result = await postCheckout({
        email,
        cardNumber: card,
        password,
        items: lines,
        simulateServerError,
      });
      getClient()?.event('checkout_completed', { orderId: result.orderId });
      clearCart();
      window.location.hash = `#/orders/${result.orderId}`;
    } catch (error) {
      status.textContent = `Checkout failed: ${String(error)}`;
      getClient()?.addBreadcrumb({ message: 'checkout failed', category: 'checkout', level: 'warning' });
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit(false);
  });
  container.querySelector('#fail-checkout')?.addEventListener('click', () => void submit(true));
}
