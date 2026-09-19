/** UUID v4 with a fallback for WebViews that lack crypto.randomUUID (iOS < 15.4). */
export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [108, 122, 137];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** rgba() string; works on every WebView, unlike color-mix(). */
export function tint(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Blends a colour over the dark surface, giving an opaque tile colour. */
export function onSurface(hex: string, amount: number, surface: [number, number, number] = [24, 24, 28]): string {
  const [r, g, b] = hexToRgb(hex);
  const mix = (c: number, s: number) => Math.round(s + (c - s) * amount);
  return `rgb(${mix(r, surface[0])}, ${mix(g, surface[1])}, ${mix(b, surface[2])})`;
}
