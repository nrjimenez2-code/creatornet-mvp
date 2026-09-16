'use strict';
// Feed-read foundation only. Importing this module never sends traffic.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: sleep } = require('node:timers/promises');
const { readVercelCorrelation } = require('./capacity-response-correlation.cjs');
const ORIGIN = 'https://creatornet-mvp-git-feat-discov-6491dd-nrjimenez2-codes-projects.vercel.app';
const PROJECT = 'nwqfofezfzljhxolkycz';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{64}$/;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
function makePlan(raw) {
  if (!exactKeys(raw,['name','sourceCommit','deploymentId','users']) ||
      !/^[a-z0-9][a-z0-9-]{0,60}$/.test(raw.name) || !/^[a-f0-9]{40}$/.test(raw.sourceCommit) ||
      !/^dpl_[A-Za-z0-9]{10,80}$/.test(raw.deploymentId) || ![1,5,25,50].includes(raw.users))
    throw Error('Invalid staging feed plan');
  return Object.freeze({version:1,mode:'staging-sustained-feed-only',origin:ORIGIN,project:PROJECT,
    name:raw.name,sourceCommit:raw.sourceCommit,deploymentId:raw.deploymentId,users:raw.users,
    rounds:9,cadenceMs:36000,arrivalWindowMs:5000,plateauMs:300000,
    pagesPerSession:3,pageSize:20,pageDelayMs:5100,timeoutMs:15000,maxStartDelayMs:250,
    sessionBudget:raw.users*9,requestBudget:raw.users*9*3});
}
function validatePlan(plan) {
  const expected = makePlan({name:plan?.name,sourceCommit:plan?.sourceCommit,deploymentId:plan?.deploymentId,users:plan?.users});
  if (!exactKeys(plan,Object.keys(expected)) || Object.keys(expected).some(key=>plan[key]!==expected[key]))
    throw Error('Plan differs from the bounded staging contract');
  return expected;
}
const digest = plan => crypto.createHash('sha256').update(JSON.stringify(validatePlan(plan))).digest('hex');

// Absolute slots do not move when a journey is slow. No catch-up queue.
async function schedule(plan, journey, record, ports={}) {
  const now=ports.now??(()=>performance.now()), wait=ports.sleep??sleep;
  const start=now(), busy=new Set(), pending=new Set();
  let stopped=false, peak=0, failed=0, missed=0;
  try { for(let round=0;round<plan.rounds;round++) for(let user=0;user<plan.users;user++) {
    const due=round*plan.cadenceMs+(plan.users===1?0:user*plan.arrivalWindowMs/(plan.users-1));
    await wait(Math.max(0,start+due-now()));
    const delay=Math.max(0,now()-start-due), slot={round,user,dueMs:due,delayMs:delay};
    if(stopped || busy.has(user) || delay>plan.maxStartDelayMs) {
      missed++; record({type:'missed',...slot,reason:stopped?'stopped':busy.has(user)?'busy':'scheduler-late'}); continue;
    }
    record({type:'start',...slot}); busy.add(user); peak=Math.max(peak,busy.size);
    let task;
    task=Promise.resolve().then(()=>journey(slot)).catch(()=>{failed++;stopped=true;})
      .finally(()=>{busy.delete(user);pending.delete(task);});
    pending.add(task);
  }
  await wait(Math.max(0,start+plan.arrivalWindowMs+plan.plateauMs-now()));
  } finally { await Promise.allSettled([...pending]); }
  return {failed,missed,peakActiveJourneys:peak,elapsedMs:now()-start};
}

async function run(planInput,journalPath,ports={}) {
  const plan=validatePlan(planInput), hash=digest(plan), fetch=ports.fetch;
  if(typeof fetch!=='function') throw Error('Explicit staging transport required');
  const now=ports.now??(()=>performance.now()), wait=ports.sleep??sleep;
  const fd=fs.openSync(journalPath,'wx');
  // fsync before dispatch keeps first-page intents durable across interruption.
  const record=row=>{fs.writeSync(fd,JSON.stringify(row)+'\n');fs.fsyncSync(fd);};
  const actors=new Map(), sessions=new Set(), tokens=new Map();
  const samples=[],pending=new Set(); let requests=0;
  const first=now();
  try {
    record({type:'plan',plan,digest:hash});
    const scheduled=await schedule(plan,async slot=>{
      let session,offset=0; const seen=new Set();
      for(let page=0;page<plan.pagesPerSession;page++) {
        if(page) await wait(plan.pageDelayMs);
        if(++requests>plan.requestBudget) throw Error('Request budget exceeded');
        const id=slot.round+':'+slot.user+':'+page;
        const intent={type:'intent',id,user:slot.user,round:slot.round,page,
          ...(session?{session}:{})};
        record(intent); pending.add(id);
        const params=new URLSearchParams({tab:'discover',offset:String(offset),limit:String(plan.pageSize)});
        if(session) params.set('session',session);
        const begin=now(),at=new Date().toISOString(); let status=null,valid=false,requestId=null;
        const serverTiming={};
        try {
          const response=await fetch(ORIGIN+'/api/feed?'+params,{method:'GET',redirect:'error',
            headers:tokens.has(slot.user)?{'x-cn-discover-actor':tokens.get(slot.user)}:{},
            signal:AbortSignal.timeout(plan.timeoutMs)});
          status=response.status;
          const correlation=readVercelCorrelation(response.headers?.get?.('x-vercel-id'));
          if(correlation.status==='present') requestId=correlation.value;
          for(const match of (response.headers?.get?.('server-timing')??'').matchAll(/(?:^|,\s*)(identity|session|page|dbtotal|dbmax|dbcount|uptime|invocation|total|bootimports|bootregister|bootage);dur=([\d.]+)(?=,|$)/g)) {
            const value=Number(match[2]);if(Number.isFinite(value)&&value>=0)serverTiming[match[1]]=value;
          }
          const data=await response.json();
          if(!response.ok || !UUID.test(data.session??'') || !TOKEN.test(data.actorToken??'') ||
             !Array.isArray(data.items) || data.items.length!==plan.pageSize ||
             data.items.some(item=>!UUID.test(item?.post_id??'')) ||
             !Number.isSafeInteger(data.nextOffset) || data.nextOffset<=offset || typeof data.hasMore!=='boolean' ||
             (page<plan.pagesPerSession-1 && !data.hasMore)) throw Error('Feed contract or catalog coverage failed');
          const actor='anon:'+data.actorToken.split('.')[0];
          // Record known ownership before subsequent validation can fail.
          record({type:'result',id,user:slot.user,round:slot.round,page,session:data.session,actor});pending.delete(id);
          if(session && session!==data.session) throw Error('Pagination session changed');
          if(!session && sessions.has(data.session)) throw Error('Session reused');
          if(actors.has(slot.user) && actors.get(slot.user)!==actor) throw Error('Returning actor changed');
          if([...actors].some(([user,value])=>user!==slot.user&&value===actor)) throw Error('Viewer actors are not distinct');
          for(const item of data.items) { if(seen.has(item.post_id)) throw Error('Duplicate post'); seen.add(item.post_id); }
          actors.set(slot.user,actor);tokens.set(slot.user,data.actorToken);sessions.add(data.session);
          session=data.session;offset=data.nextOffset;valid=true;
        } finally {
          const sample={type:'sample',id,kind:page?'feed-next':'feed-first',status,valid,at,requestId,serverTiming,
            dispatchMs:now()-begin,journeyScheduledToResponseMs:now()-first-slot.dueMs,
            startDelayMs:slot.delayMs,phase:begin-first<plan.arrivalWindowMs?'startup':'plateau'};
          samples.push(sample);record(sample);
        }
      }
    },record,{now,sleep:wait});
    const distribution=rows=>{const values=rows.map(row=>row.dispatchMs).sort((a,b)=>a-b);
      return {count:values.length,p50:values[Math.ceil(values.length*.5)-1]??null,
        p95:values[Math.ceil(values.length*.95)-1]??null,p99:values[Math.ceil(values.length*.99)-1]??null};};
    const errors=samples.filter(row=>!row.valid).length;
    const summary={type:'complete',...scheduled,requests,errors,unresolved:pending.size,distinctActors:actors.size,
      sessions:sessions.size,full:distribution(samples),plateau:distribution(samples.filter(row=>row.phase==='plateau')),
      first:distribution(samples.filter(row=>row.kind==='feed-first')),next:distribution(samples.filter(row=>row.kind==='feed-next')),
      accepted:!scheduled.failed&&!scheduled.missed&&!errors&&!pending.size&&requests===plan.requestBudget&&
        distribution(samples).p95<=300,
      limitation:'Feed-only read workload, not video playback, signed-in users, event writes or mixed 1000/10000-user capacity. Percentiles include timed failed responses; missed slots are reported separately and fail acceptance. Source/deployment are operator-verified.'};
    record(summary);return summary;
  } finally { tokens.clear();fs.closeSync(fd); }
}

function recover(text) {
  if(typeof text!=='string'||text.length>8_000_000||!text.endsWith('\n')) throw Error('Incomplete or oversized journal');
  const rows=text.trimEnd().split('\n').map(line=>JSON.parse(line));
  const header=rows.shift();
  if(!exactKeys(header,['type','plan','digest'])||header.type!=='plan'||digest(header.plan)!==header.digest)
    throw Error('Invalid journal plan');
  const plan=validatePlan(header.plan), intents=new Map(), fixtures=new Map(), actorUsers=new Map(), samples=new Set();
  let complete=false;
  for(const row of rows) {
    if(complete) throw Error('Rows after completion');
    if(row.type==='intent') {
      if(!Number.isInteger(row.user)||row.user<0||row.user>=plan.users||!Number.isInteger(row.round)||row.round<0||row.round>=plan.rounds||
        !Number.isInteger(row.page)||row.page<0||row.page>=plan.pagesPerSession||row.id!==row.round+':'+row.user+':'+row.page||
        intents.has(row.id)||!exactKeys(row,['type','id','user','round','page',...(row.session?['session']:[])])) throw Error('Invalid intent');
      if(row.page===0 ? row.session!==undefined : !UUID.test(row.session??'')) throw Error('Invalid intent session');
      intents.set(row.id,{...row,resolved:false});
    } else if(row.type==='result') {
      const intent=intents.get(row.id);
      if(!exactKeys(row,['type','id','user','round','page','session','actor'])||!intent||intent.resolved||
        row.user!==intent.user||row.round!==intent.round||row.page!==intent.page||!UUID.test(row.session)||
        !/^anon:/.test(row.actor)||!UUID.test(row.actor.slice(5))||(intent.session&&intent.session!==row.session)) throw Error('Invalid result');
      const previous=fixtures.get(row.session);
      if(previous&&(previous.actor!==row.actor||previous.user!==row.user||previous.round!==row.round)) throw Error('Conflicting ownership');
      if(actorUsers.has(row.actor)&&actorUsers.get(row.actor)!==row.user) throw Error('Shared viewer actor');
      actorUsers.set(row.actor,row.user); fixtures.set(row.session,{session:row.session,actor:row.actor,user:row.user,round:row.round});intent.resolved=true;
    } else if(row.type==='sample') {
      const intent=intents.get(row.id);
      if(!exactKeys(row,['type','id','kind','status','valid','at','requestId','serverTiming','dispatchMs','journeyScheduledToResponseMs','startDelayMs','phase'])||
        !intent||samples.has(row.id)||row.kind!==(intent.page?'feed-next':'feed-first')||typeof row.valid!=='boolean'||
        (row.status!==null&&(!Number.isInteger(row.status)||row.status<100||row.status>599))||
        typeof row.at!=='string'||!Number.isFinite(Date.parse(row.at))||
        (row.requestId!==null&&readVercelCorrelation(row.requestId).status!=='present')||
        !row.serverTiming||typeof row.serverTiming!=='object'||Array.isArray(row.serverTiming)||
        Object.entries(row.serverTiming).some(([k,v])=>!['identity','session','page','dbtotal','dbmax','dbcount','uptime','invocation','total','bootimports','bootregister','bootage'].includes(k)||!Number.isFinite(v)||v<0)||
        !['startup','plateau'].includes(row.phase)||['dispatchMs','journeyScheduledToResponseMs','startDelayMs'].some(k=>!Number.isFinite(row[k])||row[k]<0))
        throw Error('Invalid sample');
      samples.add(row.id);
    } else if(row.type==='start'||row.type==='missed') {
      if(!exactKeys(row,['type','round','user','dueMs','delayMs',...(row.type==='missed'?['reason']:[])])||
        !Number.isInteger(row.user)||row.user<0||row.user>=plan.users||!Number.isInteger(row.round)||row.round<0||row.round>=plan.rounds||
        !Number.isFinite(row.dueMs)||row.dueMs<0||!Number.isFinite(row.delayMs)||row.delayMs<0||
        (row.type==='missed'&&!['stopped','busy','scheduler-late'].includes(row.reason))) throw Error('Invalid scheduled slot');
    } else if(row.type==='complete') {
      if(!exactKeys(row,['type','failed','missed','peakActiveJourneys','elapsedMs','requests','errors','unresolved','distinctActors','sessions',
        'full','plateau','first','next','accepted','limitation'])||row.requests!==intents.size||samples.size!==intents.size||
        typeof row.accepted!=='boolean'||typeof row.limitation!=='string'||
        ['failed','missed','peakActiveJourneys','elapsedMs','requests','errors','unresolved','distinctActors','sessions'].some(k=>!Number.isFinite(row[k])||row[k]<0)||
        ['full','plateau','first','next'].some(k=>!exactKeys(row[k],['count','p50','p95','p99'])||
          !Number.isInteger(row[k].count)||row[k].count<0||['p50','p95','p99'].some(q=>row[k][q]!==null&&(!Number.isFinite(row[k][q])||row[k][q]<0))))
        throw Error('Invalid completion');
      complete=true;
    } else throw Error('Unknown journal row');
  }
  if(!complete||[...intents.values()].some(row=>!row.resolved)||fixtures.size>plan.sessionBudget) throw Error('Unsettled or unresolved run requires reconciliation');
  return {plan,digest:header.digest,fixtures:[...fixtures.values()]};
}
function cleanupSql(journalText) {
  const {fixtures,plan}=recover(journalText);
  if(!fixtures.length) throw Error('No exact fixtures to clean');
  const ids=fixtures.map(f=>`'${f.session}'::uuid`).join(','), actors=[...new Set(fixtures.map(f=>f.actor))];
  const actorSql=actors.map(a=>`'${a}'`).join(',');
  const values=fixtures.map(f=>`('${f.session}'::uuid,'${f.actor}')`).join(',');
  return `-- Fixed staging project ${PROJECT}; plan ${digest(plan)}. Run only after all requests settle.\nbegin;\nset local statement_timeout='30s';\nset local lock_timeout='3s';\ncreate temporary table scoped_feed_sessions(id uuid primary key,actor text not null) on commit drop;\ninsert into scoped_feed_sessions values ${values};\ndo $$ begin\n perform 1 from public.discover_sessions_v1 where id in (${ids}) for update;\n if (select count(*) from public.discover_sessions_v1 s join scoped_feed_sessions x on x.id=s.id and x.actor=s.actor where s.user_id is null and s.tab='discover' and s.pilot_id is null)<>${fixtures.length} then raise exception 'Missing or foreign session'; end if;\n if exists(select 1 from public.discover_sessions_v1 where actor in (${actorSql}) and id not in (${ids})) then raise exception 'Unlisted actor session'; end if;\n if exists(select 1 from public.discover_identity_links_v1 where anonymous_id in (${actors.map(a=>`'${a.slice(5)}'::uuid`).join(',')})) then raise exception 'Claimed actor'; end if;\n if exists(select 1 from public.discover_events_v1 where actor in (${actorSql})) or exists(select 1 from public.discover_watch_v1 where session_id in (${ids})) or exists(select 1 from public.discover_pilot_exposures_v1 where session_id in (${ids})) then raise exception 'Unexpected activity in feed-only scope'; end if;\nend $$;\ndelete from public.discover_sessions_v1 s using scoped_feed_sessions x where s.id=x.id and s.actor=x.actor and s.user_id is null;\ncommit;\n`;
}
module.exports={ORIGIN,PROJECT,makePlan,validatePlan,digest,schedule,run,recover,cleanupSql};
