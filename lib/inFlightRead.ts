// Share only overlapping reads. Completed results and failures are never cached.
export function inFlightRead<T>() {
 const pending = new Map<string, Promise<T>>();
 return (key: string, read: () => Promise<T>): Promise<T> => {
  const existing = pending.get(key);
  if (existing) return existing;
  const request = Promise.resolve().then(read).then(
   value => { pending.delete(key); return value; },
   error => { pending.delete(key); throw error; },
  );
  pending.set(key, request);
  return request;
 };
}
