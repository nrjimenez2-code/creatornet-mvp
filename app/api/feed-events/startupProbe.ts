// Separate record: feed and feed-events may share a JS realm.
// Keep first and dependency-free; earlier framework work is outside this span.
export const routeImportStarted = (() => {
  try { return process.env.VERCEL_ENV === 'preview' ? performance.now() : undefined; }
  catch { return undefined; }
})();
