import { getClient } from '../bugsee-client';

// Live order-status feed over Server-Sent Events (EventSource) — a real S7 capture source, and a
// genuinely useful page (you placed an order, here is what happens to it).

export function renderOrders(container: HTMLElement, params: Record<string, string>): void {
  const orderId = params.id ?? 'ORD-0000';
  container.innerHTML = `
    <section class="block">
      <h1>Order ${orderId}</h1>
      <p class="muted">Live status over Server-Sent Events.</p>
      <ol id="timeline" class="col"></ol>
    </section>
  `;
  const timeline = container.querySelector('#timeline') as HTMLElement;

  const source = new EventSource('/api/orders/stream');
  source.addEventListener('status', (event) => {
    const data = JSON.parse((event as MessageEvent).data) as { status: string; at: number };
    const li = document.createElement('li');
    li.textContent = `${new Date(data.at).toLocaleTimeString()} — ${data.status}`;
    timeline.appendChild(li);
    getClient()?.addBreadcrumb({
      message: `order ${orderId} status: ${data.status}`,
      category: 'orders',
      level: 'info',
    });
  });
  source.addEventListener('done', () => {
    const li = document.createElement('li');
    li.textContent = 'Delivered. Thanks for shopping at Widget Shop!';
    timeline.appendChild(li);
    source.close();
  });
  source.onerror = () => {
    const li = document.createElement('li');
    li.textContent = 'Order stream closed.';
    timeline.appendChild(li);
    source.close();
  };

  // Close the stream if the user navigates away.
  const stop = (): void => source.close();
  window.addEventListener('hashchange', stop, { once: true });
}
