// Exercise the installed Next.js cache implementation, with only its storage
// backend and the database reader replaced. No server or network is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { AsyncLocalStorage } = require('node:async_hooks');
const ts = require('typescript');
globalThis.AsyncLocalStorage = AsyncLocalStorage;
globalThis.fetch = async () => { throw new Error('Network forbidden in cache regression'); };
process.env.VERCEL = '1';
const { workAsyncStorage } = require('next/dist/server/app-render/work-async-storage.external');

const filename = path.resolve(__dirname, '../lib/discoverSharedRead.ts');
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { discoverSharedRead } = compiled.exports;

async function scenario(ageMs) {
  let reads = 0, writes = 0;
  const store = {
    nextFetchId: 1,
    incrementalCache: {
      generateCacheKey: async () => 'test-only',
      generateSimpleCacheKey: async () => 'test-only',
      get: async () => ({ isStale: true, value: { kind: 'FETCH', data: {
        body: JSON.stringify({ value: ['cached'], readAt: Date.now() - ageMs }),
      } } }),
      set: async () => { writes++; },
    },
  };
  const result = await workAsyncStorage.run(store, () => discoverSharedRead('inventory', async () => {
    reads++;
    await new Promise(resolve => setImmediate(resolve));
    return ['fresh'];
  }));
  await Promise.all(Object.values(store.pendingRevalidates || {}));
  assert.equal(reads, 1, 'background refresh and fallback must use one DB read');
  assert.equal(writes, 1, 'the actual Next background refresh must persist its result');
  assert.deepEqual(result, ageMs > 60000 ? ['fresh'] : ['cached']);
  return { ageMs, reads, writes, result };
}

(async () => {
  const cases = [await scenario(61000), await scenario(31000)];
  console.log(JSON.stringify({ nextVersion: require('next/package.json').version, cases }));
})().catch(error => { console.error(error); process.exitCode = 1; });
