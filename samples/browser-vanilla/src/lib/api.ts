// Thin fetch wrapper over the local Widget Shop API (server/api-plugin.ts, mounted on the same
// Vite-served origin at :5301). Used by every real page, so it is also the S7 network-capture
// surface: the SDK's fetch/XHR/WS/SSE interceptors sit underneath every call this file makes.

export interface Product {
  id: string;
  name: string;
  price: number;
  category: string;
  description: string;
  image: string;
  priceHistory: number[];
  stock: number;
}

export async function fetchProducts(): Promise<Product[]> {
  const res = await fetch('/api/products');
  if (!res.ok) throw new Error(`products fetch failed: ${res.status}`);
  return (await res.json()) as Product[];
}

export async function fetchProduct(id: string): Promise<Product | undefined> {
  const res = await fetch(`/api/products/${id}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`product fetch failed: ${res.status}`);
  return (await res.json()) as Product;
}

export interface CheckoutPayload {
  email: string;
  cardNumber: string;
  password: string;
  items: Array<{ id: string; qty: number }>;
  simulateServerError?: boolean;
}

export interface CheckoutResult {
  orderId: string;
  status: string;
}

export async function postCheckout(payload: CheckoutPayload): Promise<CheckoutResult> {
  const res = await fetch('/api/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as CheckoutResult & { error?: string; message?: string };
  if (!res.ok) throw new Error(body.message ?? `checkout failed: ${res.status}`);
  return body;
}
