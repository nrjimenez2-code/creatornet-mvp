/** Same-origin website transport unless a platform explicitly installs an adapter. */
let transport: typeof fetch | null = null;
export function setApiTransport(next: typeof fetch | null) { transport = next; }
export const apiFetch: typeof fetch = (input, init) => (transport ?? globalThis.fetch)(input, init);
