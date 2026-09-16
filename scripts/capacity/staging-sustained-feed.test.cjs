'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {makePlan,validatePlan,schedule,run,recover,cleanupSql,ORIGIN}=require('./staging-sustained-feed.cjs');
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const plan=()=>makePlan({name:'isolated',sourceCommit:'a'.repeat(40),deploymentId:'dpl_isolatedfixture',users:5});
function clock() {
  let time=0,queued=false; const timers=[];
  const pump=()=>{queued=false;if(!timers.length)return;timers.sort((a,b)=>a.due-b.due);time=timers[0].due;
    const ready=timers.filter(t=>t.due<=time);for(const timer of ready)timers.splice(timers.indexOf(timer),1);
    for(const timer of ready)timer.resolve();if(timers.length)queue();};
  const queue=()=>{if(!queued){queued=true;setImmediate(pump);}};
  return {now:()=>time,sleep:ms=>new Promise(resolve=>{timers.push({due:time+ms,resolve});queue();})};
}
function transport(fail) {
  let actors=0,sessions=0,calls=0;const rows=[];
  return {rows,fetch:async(input,init)=>{
    calls++;if(fail)fail(calls,input,init);
    assert.equal(new URL(input).origin,ORIGIN);assert.equal(init.redirect,'error');assert.ok(init.signal);
    const url=new URL(input),page=Number(url.searchParams.get('offset'))/20;
    const actor=init.headers['x-cn-discover-actor']??uuid(100000+(++actors))+'.'+'f'.repeat(64);
    const session=url.searchParams.get('session')??uuid(++sessions);
    rows.push({actor,session,page});
    return {ok:true,status:200,json:async()=>({session,actorToken:actor,
      items:Array.from({length:20},(_,i)=>({post_id:uuid(200000+page*20+i)})),nextOffset:(page+1)*20,hasMore:true})};
  }};
}
function file(t) {const folder=fs.mkdtempSync(path.join(os.tmpdir(),'cn-sustained-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));return path.join(folder,'run.jsonl');}
test('fixed staging plan rejects production, unknown fields and unsupported capacity',()=>{
  assert.equal(validatePlan(plan()).requestBudget,135);
  for(const update of [{origin:'https://www.creatornet.net'},{extra:true},{users:1000},{sessionBudget:999}])
    assert.throws(()=>validatePlan({...plan(),...update}));
});
test('slow journeys miss fixed slots rather than overlapping or catching up',async()=>{
  const c=clock(),records=[],starts=[];
  const result=await schedule({users:1,rounds:3,cadenceMs:10,arrivalWindowMs:0,plateauMs:30,maxStartDelayMs:1},
    async slot=>{starts.push(slot.dueMs);await c.sleep(15);},row=>records.push(row),c);
  assert.deepEqual(starts,[0,20]);assert.equal(result.missed,1);assert.equal(result.peakActiveJourneys,1);
  assert.equal(records.find(row=>row.type==='missed').reason,'busy');
});
test('scheduler lateness is explicit and is not a catch-up burst',async()=>{
  let time=0,starts=0;const records=[];
  const result=await schedule({users:1,rounds:2,cadenceMs:10,arrivalWindowMs:0,plateauMs:20,maxStartDelayMs:1},
    async()=>{starts++;},row=>records.push(row),{now:()=>time,sleep:async ms=>{time+=ms+2;}});
  assert.equal(starts,0);assert.equal(result.missed,2);assert.ok(records.every(r=>r.reason==='scheduler-late'));
});
test('journal failure drains already-started journeys before returning',async()=>{
  const c=clock();let settled=false;
  await assert.rejects(schedule({users:2,rounds:1,cadenceMs:10,arrivalWindowMs:1,plateauMs:5,maxStartDelayMs:1},
    async()=>{await c.sleep(10);settled=true;},row=>{if(row.user===1)throw Error('disk failure');},c));
  assert.equal(settled,true);
});
test('five-user complete run preserves actors across nine sessions and journals no credentials',async t=>{
  const journal=file(t),fake=transport(),result=await run(plan(),journal,{...clock(),fetch:fake.fetch});
  assert.equal(result.accepted,true);assert.equal(result.requests,135);assert.equal(result.sessions,45);
  assert.equal(result.distinctActors,5);assert.equal(result.missed,0);assert.ok(result.elapsedMs>=305000);
  const text=fs.readFileSync(journal,'utf8');assert.ok(!text.includes('f'.repeat(64)));assert.ok(!text.includes('actorToken'));
  const manifest=recover(text);assert.equal(manifest.fixtures.length,45);
  const groups=Object.groupBy(manifest.fixtures,f=>f.actor);assert.equal(Object.keys(groups).length,5);
  assert.ok(Object.values(groups).every(group=>group.length===9));
  const sql=cleanupSql(text);assert.match(sql,/Unlisted actor session/);assert.match(sql,/Claimed actor/);
  assert.match(sql,/Unexpected activity/);assert.match(sql,/<>45/);assert.ok(!sql.includes('delete from public.posts'));
});
test('lost first response is retained and blocks cleanup',async t=>{
  const journal=file(t),fake=transport(n=>{if(n===1)throw Error('lost after server commit');});
  const result=await run(plan(),journal,{...clock(),fetch:fake.fetch});
  assert.equal(result.accepted,false);assert.ok(result.unresolved>=1);assert.ok(result.missed>0);
  assert.throws(()=>cleanupSql(fs.readFileSync(journal,'utf8')),/reconciliation/);
});
test('existing artifact prevents all network activity',async t=>{
  const journal=file(t);fs.writeFileSync(journal,'existing');let calls=0;
  await assert.rejects(run(plan(),journal,{fetch:async()=>{calls++;}}));assert.equal(calls,0);
});
test('recovery rejects partial, tampered-plan and unknown-row journals',async t=>{
  const journal=file(t);await run(plan(),journal,{...clock(),fetch:transport().fetch});
  const text=fs.readFileSync(journal,'utf8');assert.throws(()=>recover(text.slice(0,-1)));
  const rows=text.trim().split('\n').map(JSON.parse);rows[0].plan.users=50;
  assert.throws(()=>recover(rows.map(JSON.stringify).join('\n')+'\n'));
  assert.throws(()=>recover(text+'{"type":"unexpected"}\n'));
  const extra=text.trim().split('\n').map(JSON.parse);extra.find(row=>row.type==='sample').unknown=true;
  assert.throws(()=>recover(extra.map(JSON.stringify).join('\n')+'\n'),/Invalid sample/);
});
test('duplicate sessions or actors fail measurement instead of inflating users',async t=>{
  const journal=file(t),fake=transport();
  const result=await run(plan(),journal,{...clock(),fetch:async(...args)=>{
    const response=await fake.fetch(...args);const data=await response.json();
    data.actorToken=uuid(900000)+'.'+'f'.repeat(64);return {...response,json:async()=>data};
  }});
  assert.equal(result.accepted,false);assert.ok(result.failed>0);
  assert.throws(()=>recover(fs.readFileSync(journal,'utf8')),/Shared viewer actor/);
});
