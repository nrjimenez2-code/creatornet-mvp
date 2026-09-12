const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectTests } = require('./ci-tests.cjs');
const page = 'app/dashboard/closers/page.tsx';
const change = path => ({ status: 'M', path });
const choose = (before, after) => selectTests([change(page)], () => before, () => after);
test('booking styles include booking and payment interaction tests', () => {
  assert.deepEqual(selectTests([change('app/dashboard/closers/bookings.module.css')]).tests,
    ['__tests__/booking-destinations-ui.test.ts', '__tests__/exact-clock-isolation.test.ts', '__tests__/installment-link-ui.test.ts', '__tests__/landing-links-and-facts.test.ts', '__tests__/legal-pages-wired.test.ts', '__tests__/single-auth-flow.test.ts']);
});
test('markup, text and static styling can use focused checks', () => {
  assert.equal(choose('export default function Page(){ return <div><button onClick={save}>Save</button></div> }', 'export default function Page(){ return <section className="panel"><button onClick={save}>Save changes</button></section> }').mode, 'focused');
});
test('handlers, imports and JSX expressions require full checks', () => {
  for (const [before, after] of [
    ['const save = () => update(1);', 'const save = () => update(2);'],
    ['import X from "a";', 'import X from "b";'],
    ['const p = <button onClick={save}/>;', 'const p = <button onClick={remove}/>;'],
    ['const p = <X {...safe}/>;', 'const p = <X {...unsafe}/>;'],
    ['const p = <button type="button"/>;', 'const p = <button type="submit"/>;'],
    ['const p = <Safe/>;', 'const p = <Unsafe/>;'],
  ]) assert.equal(choose(before, after).mode, 'full');
});
test('shared, feed, auth, payments, config and CI paths always run full suite', () => {
  for (const path of ['components/Feed.tsx', 'app/globals.css', 'app/api/book/route.ts', 'lib/stripe.ts', 'package-lock.json', '.github/workflows/ci.yml', 'scripts/ci-tests.cjs', 'scripts/ci-tests.test.cjs']) {
    assert.equal(selectTests([change('app/profile/edit/profile-editor.module.css'), change(path)]).mode, 'full');
  }
});
test('missing diff, deleted/new paths and unreadable pages fail closed', () => {
  assert.equal(selectTests([]).mode, 'full');
  for (const status of ['A', 'D', 'R100']) assert.equal(selectTests([{ status, path: page }]).mode, 'full');
  assert.equal(selectTests([change(page)], () => { throw Error(); }).mode, 'full');
});
test('combined UI areas include all affected suites and deduplicate', () => {
  assert.equal(selectTests([change('app/profile/edit/profile-editor.module.css'), change('app/dashboard/closers/bookings.module.css'), change('__tests__/installment-link-ui.test.ts')]).tests.length, 3 + 4);
});

test('new stylesheets and tests inside a UI area stay focused; new components fail closed', () => {
  for (const path of ['app/dashboard/earnings/earnings.module.css', '__tests__/earnings-page-ui.test.ts']) {
    const result = selectTests([{ status: 'A', path }]);
    assert.equal(result.mode, 'focused'); assert.ok(result.tests.includes('__tests__/earnings-page-ui.test.ts'));
  }
  assert.equal(selectTests([{ status: 'A', path: 'components/analytics/AnalyticsSelect.tsx' }]).mode, 'full');
  const result = selectTests([change('components/StripeConnectBanner.tsx')], () => 'const a = 1;', () => 'const a = 1;');
  assert.ok(result.tests.includes('__tests__/stripe-connect-session.test.ts'));
  assert.ok(result.tests.includes('__tests__/earnings-connect-access.test.ts'));
});
test('UI mapping never suppresses backend or dependency changes', () => {
  for (const path of ['lib/analytics-dashboard-server.ts','lib/creatorEarningsView.ts','app/api/stripe/connect/onboard/route.ts','package.json','.github/workflows/ci.yml']) {
    assert.equal(selectTests([change('app/dashboard/earnings/page.tsx'),change(path)]).mode,'full');
  }
});
test('mapped components get the same cosmetic-only check as pages', () => {
  const pick = (before, after) => selectTests([change('components/StripeConnectBanner.tsx')], () => before, () => after);
  assert.equal(pick('const { data } = await getActionSession();', 'const { data } = await createClient().auth.getSession();').mode, 'full');
  assert.equal(pick('const p = <button onClick={connect}>Connect</button>;', 'const p = <button onClick={start}>Connect</button>;').mode, 'full');
  assert.equal(pick('const p = <div className="a">Connect Stripe</div>;', 'const p = <section className="b">Connect your Stripe account</section>;').mode, 'focused');
  assert.equal(selectTests([change('app/dashboard/earnings/page.tsx')], () => 'export default function P(){ return <h1>Earnings</h1> }', () => 'export default function P(){ return <h1>Your earnings</h1> }').mode, 'focused');
});
test('every focused run includes the tree-scanning invariant suites', () => {
  const result = selectTests([change('app/dashboard/earnings/earnings.module.css')]);
  assert.equal(result.mode, 'focused');
  for (const suite of ['__tests__/single-auth-flow.test.ts', '__tests__/legal-pages-wired.test.ts', '__tests__/landing-links-and-facts.test.ts', '__tests__/exact-clock-isolation.test.ts']) assert.ok(result.tests.includes(suite), suite);
});
test('editing the selector itself runs the full suite', () => {
  assert.equal(selectTests([change('scripts/ci-tests.cjs')]).mode, 'full');
  assert.equal(selectTests([change('scripts/ci-tests.test.cjs')]).mode, 'full');
});
