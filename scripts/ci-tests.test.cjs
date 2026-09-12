const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectTests } = require('./ci-tests.cjs');
const page = 'app/dashboard/closers/page.tsx';
const change = path => ({ status: 'M', path });
const choose = (before, after) => selectTests([change(page)], () => before, () => after);
test('booking styles include booking and payment interaction tests', () => {
  assert.deepEqual(selectTests([change('app/dashboard/closers/bookings.module.css')]).tests,
    ['__tests__/booking-destinations-ui.test.ts', '__tests__/installment-link-ui.test.ts']);
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
  for (const path of ['components/Feed.tsx', 'app/globals.css', 'app/api/book/route.ts', 'lib/stripe.ts', 'package-lock.json', '.github/workflows/ci.yml']) {
    assert.equal(selectTests([change('app/profile/edit/profile-editor.module.css'), change(path)]).mode, 'full');
  }
});
test('missing diff, deleted/new paths and unreadable pages fail closed', () => {
  assert.equal(selectTests([]).mode, 'full');
  for (const status of ['A', 'D', 'R100']) assert.equal(selectTests([{ status, path: page }]).mode, 'full');
  assert.equal(selectTests([change(page)], () => { throw Error(); }).mode, 'full');
});
test('combined UI areas include all affected suites and deduplicate', () => {
  assert.equal(selectTests([change('app/profile/edit/profile-editor.module.css'), change('app/dashboard/closers/bookings.module.css'), change('__tests__/installment-link-ui.test.ts')]).tests.length, 3);
});

test('analytics and earnings UI additions select their affected tests', () => {
  for (const path of ['components/analytics/AnalyticsSelect.tsx', 'app/dashboard/earnings/earnings.module.css']) {
    const result = selectTests([{status:'A',path}]);
    assert.equal(result.mode,'focused'); assert.ok(result.tests.length >= 2);
  }
  const result = selectTests([change('components/StripeConnectBanner.tsx')]);
  assert.ok(result.tests.includes('__tests__/stripe-connect-session.test.ts'));
  assert.ok(result.tests.includes('__tests__/earnings-connect-access.test.ts'));
});
test('UI mapping never suppresses backend or dependency changes', () => {
  for (const path of ['lib/analytics-dashboard-server.ts','lib/creatorEarningsView.ts','app/api/stripe/connect/onboard/route.ts','package.json','.github/workflows/ci.yml']) {
    assert.equal(selectTests([change('app/dashboard/earnings/page.tsx'),change(path)]).mode,'full');
  }
});
test('selector maintenance runs every mapped suite but does not hide unknown changes', () => {
  const result = selectTests([change('scripts/ci-tests.cjs')]);
  assert.equal(result.mode,'focused'); assert.equal(result.tests.length,9);
  assert.equal(selectTests([change('scripts/ci-tests.cjs'),change('lib/auth.ts')]).mode,'full');
});
