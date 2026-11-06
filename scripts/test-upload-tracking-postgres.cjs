// Runs only an owned, disposable loopback PostgreSQL cluster. No provider calls.
async function main(){
const fs=await import('node:fs');
const path=await import('node:path');
const net=await import('node:net');
const {execFile,spawn}=await import('node:child_process');
const {promisify}=await import('node:util');
const run=promisify(execFile);
const {default:assert}=await import('node:assert/strict');
const root=path.resolve(__dirname,'..');
const [bin,work]=process.argv.slice(2).map(p=>path.resolve(p));
if(!bin||!work||!path.basename(work).startsWith('upload-pg-'))throw Error('Explicit owned upload-pg workspace required');
if(fs.existsSync(work))throw Error('Use a fresh disposable workspace; no deletion or reuse is performed');
fs.mkdirSync(work,{recursive:true});
const cluster=path.join(work,'data');
const env={...process.env,PGTZ:'UTC',PGPASSFILE:path.join(work,'empty-passfile'),PGSERVICEFILE:path.join(work,'empty-service'),PGSYSCONFDIR:work};
fs.writeFileSync(env.PGPASSFILE,'');fs.writeFileSync(env.PGSERVICEFILE,'');
const checks=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let started=false,port;
async function command(exe,args,extra={}){
  if(exe==='pg_ctl') {
    // Windows descendants can retain execFile's pipes. Use a task-owned log
    // descriptor and wait on the actual pg_ctl exit instead.
    const descriptor=fs.openSync(path.join(work,'pg-ctl.log'),'a');
    try{return await new Promise((resolve,reject)=>{
      const child=spawn(path.join(bin,'pg_ctl.exe'),args,{env,windowsHide:true,stdio:['ignore',descriptor,descriptor]});
      child.on('error',reject);child.on('exit',code=>code===0?resolve({stdout:''}):reject(Error('pg_ctl exited '+code)));
    });}finally{fs.closeSync(descriptor);}
  }
  return run(path.join(bin,exe+'.exe'),args,{env,windowsHide:true,maxBuffer:1024*1024,...extra});
}
async function sql(query,app='upload-local-check') {
  const out=await command('psql',['-X','-w','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(port),'-U','upload_test','-d','postgres','-c',query],{env:{...env,PGAPPNAME:app}});
  return out.stdout.trim();
}
async function denied(query,pattern=/permission denied|row-level security|upload_/) {
  try{await sql(query);throw Error('Expected refusal');}catch(e){if(e.message==='Expected refusal')throw e;assert.match(e.stderr||'',pattern);}
}
const actor='a1111111-1111-4111-8111-111111111111';
const other='c3333333-3333-4333-8333-333333333333';
let seq=1;
function id(){return 'b2222222-2222-4222-8222-'+String(seq++).padStart(12,'0');}
function reserve(attempt,purpose='premium',size=10,operation=attempt){const image=purpose==='avatar'||purpose==='thumbnail';return `select public.reserve_upload_attempt_v1('${attempt}','${operation}','${actor}','${purpose}','${image?'image/png':'video/mp4'}',${size},'${image?'png':'mp4'}','${purpose==='avatar'?'avatars':purpose==='video'||purpose==='thumbnail'?'media':'premium'}')`;}
function asActor(query,operation='object.upload',owner=actor){return `begin;set local role authenticated;select set_config('request.jwt.claim.sub','${owner}',true);select set_config('storage.operation','${operation}',true);${query};commit;`;}
async function check(name,fn){await fn();checks.push(name);process.stdout.write('PASS '+name+'\n');}
async function until(query,predicate){const deadline=Date.now()+6000;while(Date.now()<deadline){const out=await sql(query);if(predicate(out))return;await wait(60);}throw Error('Concurrent session condition not observed');}
await (async()=>{
  port=await new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
  await command('initdb',['-D',cluster,'-U','upload_test','--auth=trust','--encoding=UTF8','--no-locale']);
  await command('pg_ctl',['-D',cluster,'-l',path.join(work,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port} -c max_connections=15`,'-w','start']);started=true;
  await sql(fs.readFileSync(path.join(root,'test-support/upload-tracking-storage.sql'),'utf8'));
  await sql(fs.readFileSync(path.join(root,'supabase/migrations/20261023030607_durable_critical_abuse_admission.sql'),'utf8'));
  await sql(fs.readFileSync(path.join(root,'supabase/upload_tracking_v1.sql'),'utf8'));
  await check('default closed and never restore-ready',async()=>{
    const snapshot=JSON.parse(await sql('set role service_role;select public.upload_maintenance_snapshot_v1()'));
    assert.equal(snapshot.control.paused,true);assert.equal(snapshot.safeToRestore,false);assert.equal(snapshot.legacyUploadCoverage,'unknown');
    assert.deepEqual(JSON.parse(await sql('set role service_role;select public.list_upload_attempts_v1()')),{attempts:[],nextCursor:null});
    await denied(reserve(id()),/upload_admission_paused/);
  });
  await check('journal and mutation RPCs inaccessible to application roles',async()=>{
    for(const role of ['anon','authenticated']) {
      await denied(`set role ${role};select * from upload_tracking.attempts_v1`);
      await denied(`set role ${role};select public.set_upload_admission_v1(false,0,'forbidden')`);
      await denied(`set role ${role};${reserve(id())}`);
    }
  });
  await sql("set role service_role;select public.set_upload_admission_v1(false,0,'local_test')");
  const first=id();let row=JSON.parse(await sql('set role service_role;'+reserve(first))).attempt;
  await check('idempotent reservation and unique retry keys',async()=>{
    const replay=JSON.parse(await sql('set role service_role;'+reserve(first)));assert.equal(replay.created,false);
    const second=JSON.parse(await sql('set role service_role;'+reserve(id(),'premium',10,first))).attempt;assert.notEqual(second.object_key,row.object_key);
    await denied('set role service_role;'+reserve(first,'premium',11),/upload_attempt_conflict/);
  });
  await check('all purposes require exact known size and preserve literal provider keys',async()=>{
    for(const purpose of ['video','thumbnail','premium','avatar'])await denied('set role service_role;'+reserve(id(),purpose,'null'),/upload_invalid_request/);
    for(const purpose of ['video','thumbnail','premium','avatar']){
      const attempt=id(),image=purpose==='thumbnail'||purpose==='avatar';
      const actual=JSON.parse(await sql('set role service_role;'+reserve(attempt,purpose))).attempt;
      const prefix=purpose==='video'?'videos/':purpose==='thumbnail'?'thumbnails/':'';
      assert.equal(actual.object_key,prefix+actor+'/'+(prefix?'launch_':'')+attempt+(image?'.png':'.mp4'));
    }
    const operation=id(),one=id(),two=id();
    const a=JSON.parse(await sql('set role service_role;'+reserve(one,'video',10,operation))).attempt;
    const b=JSON.parse(await sql('set role service_role;'+reserve(two,'video',10,operation))).attempt;
    assert.equal(a.object_key,'videos/'+actor+'/launch_'+one+'.mp4');assert.equal(b.object_key,'videos/'+actor+'/launch_'+two+'.mp4');
  });
  await check('legacy lookup is service-only exact read without reservation or quota mutations',async()=>{
    const a='a'.repeat(64),o='b'.repeat(64),c='c'.repeat(64),resource='videos/'+actor+'/launch_'+id()+'.mp4';
    await sql("insert into abuse_private.upload_reservations values('public_upload','"+a+"','"+o+"','"+c+"','"+resource+"',clock_timestamp())");
    const call=(actorHash=a,operation=o,contract=c,key=resource)=>"select public.find_legacy_public_upload_reservation_v1('"+actorHash+"','"+operation+"','"+contract+"','"+key+"')";
    const before=await sql("select jsonb_build_object('reservations',(select jsonb_agg(to_jsonb(r)) from abuse_private.upload_reservations r),'buckets',(select jsonb_agg(to_jsonb(b)) from abuse_private.buckets b))");
    assert.equal(JSON.parse(await sql('set role service_role;'+call())).resource,resource);
    for(const args of [['d'.repeat(64)], [a,'d'.repeat(64)],[a,o,'d'.repeat(64)],[a,o,c,resource+'other']])assert.equal(await sql('set role service_role;'+call(...args)),'');
    for(const role of ['anon','authenticated'])await denied('set role '+role+';'+call(),/permission denied/);
    const after=await sql("select jsonb_build_object('reservations',(select jsonb_agg(to_jsonb(r)) from abuse_private.upload_reservations r),'buckets',(select jsonb_agg(to_jsonb(b)) from abuse_private.buckets b))");assert.equal(after,before);
  });
  await check('direct and unknown uploads refused while open',async()=>{
    for(const operation of ['object.upload','object.upload_update','object.copy','']) {
      await denied(asActor(`insert into storage.objects(bucket_id,name,owner_id) values('premium','${row.object_key}','${actor}')`,operation));
    }
    await denied(asActor(`insert into storage.objects(bucket_id,name,owner_id) values('premium','${actor}/untracked.mp4','${actor}')`,'object.sign_upload_url'));
  });
  await check('signed admission retains existing owner entitlements',async()=>{
    const allowed=await sql(asActor(`select upload_tracking.storage_write_allowed_v1('premium','${row.object_key}')`,'storage.object.sign_upload_url'));assert.match(allowed,/\nt$/);
    await denied(asActor(`insert into storage.objects(bucket_id,name,owner_id) values('premium','${row.object_key}','${actor}')`,'object.sign_upload_url',other));
    await sql(asActor(`insert into storage.objects(bucket_id,name,owner_id) values('premium','${row.object_key}','${actor}')`,'object.sign_upload_url'));
  });
  await sql("set role service_role;select public.set_upload_admission_v1(true,1,'local_pause')");
  await check('paused gate denies signing but permits exact admitted continuation',async()=>{
    const deniedSign=await sql(asActor(`select upload_tracking.storage_write_allowed_v1('premium','${row.object_key}')`,'object.sign_upload_url'));assert.match(deniedSign,/\nf$/);
    await sql(asActor(`update storage.objects set owner_id='${actor}' where name='${row.object_key}'`,'object.upload_signed'));
    await denied(asActor(`update storage.objects set name='${actor}/untracked.mp4' where name='${row.object_key}'`,'object.upload_signed'));
    const forbiddenOld=await sql(asActor(`update storage.objects set owner_id='${actor}' where name='${row.object_key}' returning name`,'object.upload_update'));assert.ok(!forbiddenOld.includes(row.object_key));
    await denied('set role service_role;'+reserve(id()),/upload_admission_paused/);
  });
  await check('other buckets retain existing permissions',async()=>{
    await sql(asActor(`insert into storage.objects(bucket_id,name,owner_id) values('other','unchanged','${actor}')`));
  });
  await check('verified metadata and mismatch history survive pause',async()=>{
    const call=metadata=>`set role service_role;select public.observe_upload_attempt_v1('${first}','${actor}','uploaded','${JSON.stringify(metadata)}'::jsonb,null)`;
    const good={size:10,contentType:'video/mp4',etag:'first',version:null};
    let a=JSON.parse(await sql(call(good)));assert.equal(a.state,'object_observed');
    a=JSON.parse(await sql(call({...good,etag:'second'})));assert.equal(a.state,'object_mismatch');assert.equal(a.observed_object.etag,'first');
    a=JSON.parse(await sql(call(good)));assert.equal(a.state,'object_mismatch');
    const count=await sql(`select count(*) from upload_tracking.observations_v1 where attempt_id='${first}'`);assert.equal(count,'2');
    for(const bad of [{},[],{size:0,contentType:'video/mp4'},{size:1.2,contentType:'video/mp4'},{size:10,contentType:'video/mp4',token:'secret'}])await denied(call(bad),/upload_invalid_observation/);
    const another=id();await sql("set role service_role;select public.set_upload_admission_v1(false,2,'local_reopen')");await sql('set role service_role;'+reserve(another));
    const wrong=JSON.parse(await sql(`set role service_role;select public.observe_upload_attempt_v1('${another}','${actor}','uploaded','{"size":11,"contentType":"video/mp4"}'::jsonb,null)`));assert.equal(wrong.state,'object_mismatch');
  });
  await check('owner boundary, ambiguous report and CAS conflict',async()=>{
    assert.equal(await sql(`set role service_role;select public.get_upload_attempt_v1('${first}','${other}')`),'');
    await denied(`set role service_role;select public.observe_upload_attempt_v1('${first}','${other}','uploaded',null,null)`,/upload_attempt_not_found/);
    await denied("set role service_role;select public.set_upload_admission_v1(true,0,'stale')",/upload_control_conflict/);
    const a=JSON.parse(await sql(`set role service_role;select public.observe_upload_attempt_v1('${first}','${actor}','aborted',null,null)`));assert.equal(a.state,'object_mismatch');assert.equal(a.client_outcome,'aborted');
  });
  await check('pause and reopen invalidate old publication generation',async()=>{
    await denied(`set role service_role;select public.publish_upload_attempt_v1('${first}','${actor}',clock_timestamp()+interval '1 hour')`,/upload_attempt_conflict/);
    const signing=await sql(asActor(`select upload_tracking.storage_write_allowed_v1('premium','${row.object_key}')`,'object.sign_upload_url'));assert.match(signing,/\nf$/);
  });
  await check('native concurrent reserve serializes before closure',async()=>{
    const attempt=id();
    const reserving=sql(`begin;set local role service_role;${reserve(attempt)};select pg_sleep(3);commit;`,'upload-race-reserve');
    await until("select wait_event from pg_stat_activity where application_name='upload-race-reserve'",v=>v==='PgSleep');
    const closing=sql("set role service_role;select public.set_upload_admission_v1(true,3,'race_close')",'upload-race-close');
    await until("select wait_event_type from pg_stat_activity where application_name='upload-race-close'",v=>v==='Lock');
    await Promise.all([reserving,closing]);
    await denied('set role service_role;'+reserve(id()),/upload_admission_paused/);
    await denied(`set role service_role;select public.publish_upload_attempt_v1('${attempt}','${actor}',clock_timestamp()+interval '1 hour')`,/upload_admission_paused/);
  });
  await check('native concurrent publication cannot pass a held closure',async()=>{
    await sql("set role service_role;select public.set_upload_admission_v1(false,4,'race_reopen')");const attempt=id();await sql('set role service_role;'+reserve(attempt));
    const closing=sql("begin;set local role service_role;select public.set_upload_admission_v1(true,5,'held_close');select pg_sleep(3);commit;",'upload-race-held-close');
    await until("select wait_event from pg_stat_activity where application_name='upload-race-held-close'",v=>v==='PgSleep');
    const publication=sql(`set role service_role;select public.publish_upload_attempt_v1('${attempt}','${actor}',clock_timestamp()+interval '1 hour')`,'upload-race-publish');
    const outcome=publication.then(()=>({allowed:true}),e=>({allowed:false,error:e.stderr}));
    await until("select wait_event_type from pg_stat_activity where application_name='upload-race-publish'",v=>v==='Lock');
    await closing;const result=await outcome;assert.equal(result.allowed,false);assert.match(result.error,/upload_admission_paused/);
  });
  await check('service-only bounded cursor enumerates more than 100 unresolved attempts',async()=>{
    await sql("set role service_role;select public.set_upload_admission_v1(false,6,'pagination_test')");
    const calls=Array.from({length:105},()=>reserve(id())).join(';');await sql('set role service_role;'+calls);
    await sql("set role service_role;select public.set_upload_admission_v1(true,7,'pagination_closed')");
    // A tied timestamp across every page exercises the UUID tiebreaker. This is
    // test-fixture setup only; operators never rewrite the live journal.
    await sql("update upload_tracking.attempts_v1 set admitted_at='2026-11-04T00:00:00.123456Z'");
    const expected=JSON.parse(await sql("select jsonb_agg(id order by admitted_at,id) from upload_tracking.attempts_v1"));
    let cursor=null;const seen=[];let pages=0;
    do {
      const page=JSON.parse(await sql(`set role service_role;select public.list_upload_attempts_v1(${cursor?`'${cursor.admittedAt}','${cursor.id}'`:'null,null'},30)`));
      assert.ok(page.attempts.length<=30);
      for(const a of page.attempts){
        assert.equal(a.admitted_at,'2026-11-04T00:00:00.123456+00:00');
        assert.ok(!Object.keys(a).some(k=>/^(token|secret|signed_url|upload_url|authorization|cookie)$/i.test(k)));
        seen.push(a.id);
      }
      cursor=page.nextCursor;pages++;
    }while(cursor);
    assert.ok(pages>3);assert.deepEqual(seen,expected);
    for(const role of ['anon','authenticated'])await denied(`set role ${role};select public.list_upload_attempts_v1()`);
    for(const args of ['null,null,101','null,null,0','null,null,null',`null,'${first}',30`,"'2026-11-04',null,30"])
      await denied(`set role service_role;select public.list_upload_attempts_v1(${args})`,/upload_invalid_request/);
    const last=expected.at(-1),beforeLast=expected.at(-2);
    const finalPage=JSON.parse(await sql(`set role service_role;select public.list_upload_attempts_v1('2026-11-04T00:00:00.123456Z','${beforeLast}',1)`));
    assert.deepEqual(finalPage.attempts.map(a=>a.id),[last]);assert.equal(finalPage.nextCursor,null);
    assert.deepEqual(JSON.parse(await sql(`set role service_role;select public.list_upload_attempts_v1('2026-11-04T00:00:00.123456Z','${last}',30)`)),{attempts:[],nextCursor:null});
  });
  const snapshot=JSON.parse(await sql('set role service_role;select public.upload_maintenance_snapshot_v1()'));
  assert.equal(snapshot.control.paused,true);assert.equal(snapshot.unresolvedCount,snapshot.attemptCount);assert.equal(snapshot.safeToRestore,false);assert.equal(snapshot.providerQuiescenceProven,false);
  fs.writeFileSync(path.join(work,'receipt.json'),JSON.stringify({recordedAtUtc:new Date().toISOString(),postgresVersion:(await command('postgres',['--version'])).stdout.trim(),checks,checkCount:checks.length,providerAcceptance:false,hostedChanges:false,snapshot},null,2)+'\n');
})().catch(e=>{process.stderr.write((e.stack||String(e))+'\n');process.exitCode=1;}).finally(async()=>{
  if(started)await command('pg_ctl',['-D',cluster,'-m','smart','-w','stop']);
});
}
main().catch(e=>{process.stderr.write((e.stack||String(e))+'\n');process.exitCode=1;});
