const fs = require('node:fs');
const cp = require('node:child_process');
const ts = require('typescript');

// Explicit UI areas with interaction coverage. Backend and unknown paths fail closed.
const areas = [
  { ui: ['components/analytics/AnalyticsDashboard.tsx', 'components/analytics/AnalyticsSelect.tsx', 'components/analytics/analytics.module.css'], tests: ['__tests__/analytics-dashboard-ui.test.ts', '__tests__/analytics-dashboard-data.test.ts'] },
  { ui: ['app/dashboard/earnings/page.tsx', 'app/dashboard/earnings/earnings.module.css', 'components/StripeConnectBanner.tsx'], tests: ['__tests__/earnings-page-ui.test.ts', '__tests__/earnings-connect-access.test.ts', '__tests__/stripe-connect-session.test.ts', '__tests__/creator-earnings.test.ts'] },
  { page: 'app/profile/edit/page.tsx', css: 'app/profile/edit/profile-editor.module.css', tests: ['__tests__/profile-editor.test.ts'] },
  { page: 'app/dashboard/closers/page.tsx', css: 'app/dashboard/closers/bookings.module.css', tests: ['__tests__/booking-destinations-ui.test.ts', '__tests__/installment-link-ui.test.ts'] },
];

function behavior(source) {
  const file = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (file.parseDiagnostics.length) throw new Error('Cannot parse changed page');
  const result = ts.transform(file, [context => {
    const visit = node => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
        const expressions = [];
        const collect = child => {
          if (ts.isJsxAttribute(child) && child.name.getText(file) !== 'className') {
            expressions.push(ts.factory.createStringLiteral(child.getText(file)));
          }
          if (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) {
            const tag = child.tagName.getText(file);
            if (!['div', 'section', 'header', 'footer', 'main', 'article', 'span', 'p', 'h1', 'h2', 'h3'].includes(tag)) expressions.push(ts.factory.createStringLiteral(tag));
          }
          if (ts.isJsxExpression(child) && child.expression) expressions.push(ts.visitNode(child.expression, visit));
          else if (ts.isJsxSpreadAttribute(child)) expressions.push(ts.visitNode(child.expression, visit));
          else ts.forEachChild(child, collect);
        };
        collect(node);
        return ts.factory.createArrayLiteralExpression(expressions);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return root => ts.visitNode(root, visit);
  }]);
  try { return ts.createPrinter({ removeComments: true }).printFile(result.transformed[0]); }
  finally { result.dispose(); }
}

// Suites that scan the whole tree (the auth tripwire, legal/landing wiring,
// clock isolation) cannot be mapped to a path, so every focused run includes them.
const invariants = [
  '__tests__/exact-clock-isolation.test.ts',
  '__tests__/landing-links-and-facts.test.ts',
  '__tests__/legal-pages-wired.test.ts',
  '__tests__/single-auth-flow.test.ts',
];

function selectTests(changes, readBefore, readAfter) {
  const tests = new Set(invariants);
  if (!changes.length) return { mode: 'full', reason: 'No reliable changed-file scope' };
  for (const { status, path } of changes) {
    const area = areas.find(area => area.page === path || area.css === path || area.ui?.includes(path) || area.tests.includes(path));
    // Only a modified mapped file, or a new stylesheet/test inside a UI area, can stay focused.
    // The selector itself, workflows, dependencies, backend and unknown paths fail closed.
    const added = status === 'A' && ((area?.ui?.includes(path) && path.endsWith('.css')) || area?.tests.includes(path));
    if (!area || (status !== 'M' && !added)) return { mode: 'full', reason: `Unmapped, added, deleted or renamed file: ${path}` };
    // Every mapped component or page gets the same cosmetic-only check.
    if (path === area.page || (area.ui?.includes(path) && /\.tsx?$/.test(path))) {
      try {
        if (behavior(readBefore(path)) !== behavior(readAfter(path))) return { mode: 'full', reason: `UI behavior changed: ${path}` };
      } catch { return { mode: 'full', reason: `Unable to classify: ${path}` }; }
    }
    area.tests.forEach(test => tests.add(test));
  }
  return { mode: 'focused', tests: [...tests].sort(), reason: 'Known UI areas, their affected tests, and the tree-wide invariant suites' };
}

function git(args) { return cp.execFileSync('git', args, { encoding: 'utf8' }); }
function main() {
  let plan;
  try {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const base = process.env.GITHUB_EVENT_NAME === 'pull_request' ? event.pull_request.base.sha : event.before;
    if (!/^[a-f0-9]{40}$/.test(base || '') || /^0+$/.test(base)) throw new Error('Missing base');
    // No rename detection: both old and new paths must be evaluated. HEAD is the
    // tested merge tree on PRs, and the pushed tree on main (including multi-commit pushes).
    const fields = git(['diff', '--name-status', '--no-renames', '-z', base, 'HEAD']).split('\0');
    const changes = [];
    for (let i = 0; fields[i]; i += 2) changes.push({ status: fields[i], path: fields[i + 1] });
    plan = selectTests(changes, path => git(['show', `${base}:${path}`]), path => fs.readFileSync(path, 'utf8'));
  } catch { plan = { mode: 'full', reason: 'Base revision or diff unavailable' }; }
  console.log(`Test scope: ${plan.mode}. ${plan.reason}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Test scope: ${plan.mode}\n${plan.reason}\n${(plan.tests || []).join('\n')}\n`);
  const args = ['node_modules/jest/bin/jest.js', '--no-coverage'];
  if (plan.mode === 'focused') args.push('--runTestsByPath', ...plan.tests);
  const run = cp.spawnSync(process.execPath, args, { stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
}
module.exports = { selectTests };
if (require.main === module) main();
