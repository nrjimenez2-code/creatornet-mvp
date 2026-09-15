'use strict';
// Manual cloud comparison only. No application, database or login credentials.
const fs = require('node:fs');
const path = require('node:path');
const { runProductionCanary } = require('./capacity-production-canary.cjs');

function configuration(env) {
  if (env.GITHUB_REPOSITORY !== 'nrjimenez2-code/creatornet-mvp' ||
      env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' ||
      !/^[a-f0-9]{40}$/.test(env.CAPACITY_EXPECTED_SHA || '') ||
      !['5','25','50'].includes(env.CAPACITY_VIEWERS) ||
      !/^\d+$/.test(env.GITHUB_RUN_ID || '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT || ''))
    throw Error('Manual main-branch capacity configuration required');
  return {commit:env.CAPACITY_EXPECTED_SHA,stages:[Number(env.CAPACITY_VIEWERS)],
    name:`cloud-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,postsPerActor:3,primingJourneys:0};
}
module.exports={configuration};
if (require.main === module) {
  Promise.resolve().then(async()=>{
    const config=configuration(process.env);
    fs.mkdirSync(path.resolve(__dirname,'../outputs'),{recursive:true});
    const report=await runProductionCanary(config);
    if (report.groups.length!==1 || !report.groups[0].accepted || report.unresolvedFeedIntents.length) process.exitCode=2;
  }).catch(()=>{console.error('Cloud canary incomplete; retain its exact fixture journal for reconciliation.');process.exitCode=1;});
}
