const test=require('node:test');
const assert=require('node:assert/strict');
const {configuration}=require('./run-cloud-canary.cjs');
const valid={GITHUB_REPOSITORY:'nrjimenez2-code/creatornet-mvp',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',CAPACITY_EXPECTED_SHA:'a'.repeat(40),CAPACITY_VIEWERS:'5',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1'};
test('manual cloud run retains the fixed public target and bounded workload',()=>{
  assert.deepEqual(configuration(valid),{commit:'a'.repeat(40),stages:[5],name:'cloud-123-1',postsPerActor:3,primingJourneys:0});
});
test('untrusted events, forks, refs, malformed source and larger stages cannot start traffic',()=>{
  for (const patch of [{GITHUB_REPOSITORY:'fork/creatornet-mvp'},{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_REF:'refs/heads/feature'},{CAPACITY_EXPECTED_SHA:'$(oops)'},{CAPACITY_VIEWERS:'1000'},{CAPACITY_VIEWERS:'5,25'},{GITHUB_RUN_ID:'../escape'},{GITHUB_RUN_ATTEMPT:''}])
    assert.throws(()=>configuration({...valid,...patch}));
});
