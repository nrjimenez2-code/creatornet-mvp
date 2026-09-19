// Keep this dependency first and dependency-free. This marks evaluation, not
// route chunk download, parsing, compilation or previously cached imports.
export const routeImportStarted = (() => {
  try { return process.env.VERCEL_ENV === 'preview' ? performance.now() : undefined; }
  catch { return undefined; }
})();
