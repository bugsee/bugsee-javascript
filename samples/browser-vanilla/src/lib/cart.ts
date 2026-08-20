// Cart state persisted in localStorage — real app state, and a place S2 attributes can hang off
// (cart size as a Bugsee attribute) without inventing a scenario-only feature.

const STORAGE_KEY = 'widget-shop.cart.v1';

export interface CartLine {
  id: string;
  qty: number;
}

function read(): CartLine[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    return JSON.parse(raw) as CartLine[];
  } catch {
    return [];
  }
}

function write(lines: CartLine[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
  window.dispatchEvent(new CustomEvent('cart:changed', { detail: lines }));
}

export function getCart(): CartLine[] {
  return read();
}

export function addToCart(id: string, qty = 1): void {
  const lines = read();
  const existing = lines.find((l) => l.id === id);
  if (existing !== undefined) {
    existing.qty += qty;
  } else {
    lines.push({ id, qty });
  }
  write(lines);
}

export function setQty(id: string, qty: number): void {
  const lines = read().filter((l) => l.id !== id || qty > 0);
  const existing = lines.find((l) => l.id === id);
  if (existing !== undefined) existing.qty = qty;
  write(lines);
}

export function removeFromCart(id: string): void {
  write(read().filter((l) => l.id !== id));
}

export function clearCart(): void {
  write([]);
}

export function cartCount(): number {
  return read().reduce((sum, l) => sum + l.qty, 0);
}
