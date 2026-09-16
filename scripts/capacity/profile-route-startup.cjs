'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const blocker = path.join(__dirname, 'startup-network-block.cjs').replaceAll('\\', '/');
// Do not inherit credentials, local dotenv files or production configuration.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT)$/i.test(key)));
Object.assign(env, {
  NODE_ENV: 'production', NEXT_RUNTIME: 'nodejs', NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.invalid',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'ci-not-a-real-key',
  SUPABASE_SERVICE_ROLE_KEY: 'ci-not-a-real-key',
  STRIPE_SECRET_KEY: 'sk_test_ci_not_a_real_key',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_ci_not_a_real_key',
  STRIPE_WEBHOOK_SECRET: 'whsec_ci_not_a_real_key',
  R2_ACCOUNT_ID: 'ci', R2_ACCESS_KEY_ID: 'ci', R2_SECRET_ACCESS_KEY: 'ci',
  R2_BUCKET_NAME: 'ci', R2_PUBLIC_URL: 'https://example.invalid',
  NEXT_PUBLIC_SITE_URL: 'https://example.invalid',
  NEXT_PUBLIC_BASE_URL: 'https://example.invalid', APP_URL: 'https://example.invalid',
  NEXT_PUBLIC_POSTHOG_KEY: 'phc_ci_not_a_real_key',
  NEXT_PUBLIC_POSTHOG_HOST: 'https://example.invalid',
  NEXT_PUBLIC_SENTRY_DSN: '', SENTRY_AUTH_TOKEN: '',
  SENTRY_SUPPRESS_GLOBAL_ERROR_HANDLER_FILE_WARNING: '1',
  NODE_OPTIONS: '--require="' + blocker + '"',
});
function run(args, options = {}) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, timeout: 600000,
    encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ||
    result.stderr || 'Startup experiment child failed');
  return result.stdout;
}
async function child(mode) {
  require('./startup-network-block.cjs');
  const Module = require('node:module');
  const original = Module.prototype._compile;
  const modules = [];
  let parent;
  Module.prototype._compile = function(source, filename) {
    const caller = parent;
    const row = { file: path.relative(root, filename), bytes: Buffer.byteLength(source), childrenMs: 0 };
    parent = row;
    const started = performance.now();
    try { return original.call(this, source, filename); }
    finally {
      row.totalMs = performance.now() - started;
      row.selfMs = row.totalMs - row.childrenMs;
      if (caller) caller.childrenMs += row.totalMs;
      parent = caller;
      modules.push(row);
    }
  };
  const phases = {};
  const measure = async (name, work) => {
    const start = performance.now(); await work(); phases[name] = performance.now() - start;
  };
  if (mode === 'instrumented') {
    let instrumentation;
    await measure('instrumentationLoad', () => { instrumentation = require(path.join(root, '.next/server/instrumentation.js')); });
    await measure('registration', () => instrumentation.register());
  }
  await measure('feedFirstLoad', () => require(path.join(root, '.next/server/app/api/feed/route.js')));
  await measure('feedSecondLoad', () => require(path.join(root, '.next/server/app/api/feed/route.js')));
  console.log(JSON.stringify({ mode, phases, compiledFiles: modules.length,
    loadedBytes: modules.reduce((sum, row) => sum + row.bytes, 0),
    slowest: modules.sort((a, b) => b.selfMs - a.selfMs).slice(0, 15) }));
}
async function main() {
  const [command, mode, ...extra] = process.argv.slice(2);
  if (extra.length || (command !== '--child' && mode)) throw new Error('Unexpected arguments');
  if (command === '--child') {
    if (!['route-only', 'instrumented'].includes(mode)) throw new Error('Invalid mode');
    await child(mode); return;
  }
  if (fs.readdirSync(root).some(name => /^\.env(?:\.|$)/.test(name)))
    throw new Error('Use a clean checkout without dotenv files');
  if (command === '--build' || command === '--build-instrumented') {
    const configPath = path.join(root, 'next.config.ts');
    const originalConfig = fs.readFileSync(configPath, 'utf8');
    const integration = command === '--build-instrumented';
    if (integration) {
      const target = 'withSentryConfig(nextConfig, sentryConfig)';
      if (originalConfig.split(target).length !== 2) throw new Error('Unexpected Sentry build configuration');
      fs.writeFileSync(configPath, originalConfig.replace(target,
        'withSentryConfig(nextConfig, { ...sentryConfig, telemetry: false, sourcemaps: { disable: true }, release: { create: false, finalize: false } })'));
      env.SENTRY_AUTH_TOKEN = 'isolated-experiment-not-a-real-token';
    }
    try { run([require.resolve('next/dist/bin/next'), 'build'], { stdio: 'inherit' }); }
    finally { if (integration) fs.writeFileSync(configPath, originalConfig); }
    fs.mkdirSync(path.join(root, 'startup-results'), { recursive: true });
    fs.writeFileSync(path.join(root, 'startup-results/build-mode.json'),
      JSON.stringify({ sentryBuildIntegration: integration, sourceMapUpload: false, releasePublication: false }));
    return;
  }
  if (command !== '--profile') throw new Error('Use --build or --profile');
  const rows = [];
  for (const variant of ['route-only', 'instrumented']) for (let trial = 1; trial <= 3; trial++) {
    const output = run([__filename, '--child', variant], { timeout: 45000 });
    rows.push({ trial, ...JSON.parse(output.trim().split(/\r?\n/).at(-1)) });
  }
  const report = { buildMode: JSON.parse(fs.readFileSync(path.join(root, 'startup-results/build-mode.json'), 'utf8')),
    nextVersion: require('next/package.json').version, nodeVersion: process.version,
    platform: process.platform, bundler: 'default Next production build', rows,
    limitations: 'Fresh-process module loading only, no handler calls. Fake credentials and blocked Node outbound network. Filesystem cache uncontrolled. Linux CI is not the deployed Vercel runtime; no production latency or capacity claim.' };
  fs.mkdirSync(path.join(root, 'startup-results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'startup-results/route-startup.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report));
}
main().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
