'use strict';
// No remote URL, host port, npm client, app credentials, or production access.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const DB='cn_claim_page_ci',MARKER='creatornet-ephemeral-claim-v1';
const MIGRATIONS=['20260915052139_discover_inventory_batch.sql','20260916051608_discover_compact_page.sql','20260916064728_discover_anon_compact_page.sql'];
const tx="begin isolation level read committed;set local statement_timeout='8s';set local lock_timeout='2s';";
const environmentGuard=`do $$ begin
 if current_database()<>'${DB}' or current_user<>'postgres'
  or current_setting('server_version_num')::int not between 170000 and 179999 then
  raise exception 'Only the disposable PostgreSQL 17 CI database is allowed';end if;
end $$;`;
const freshGuard=`do $$ begin
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_' and n.nspname<>'information_schema')
  or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_' and n.nspname<>'information_schema')
  or exists(select 1 from pg_namespace where nspname='auth')
  or exists(select 1 from pg_roles where rolname in('anon','authenticated','untrusted','service_role')) then
  raise exception 'CI database or roles are not empty';end if;
end $$;`;
const before=`${tx}set local role service_role;
do $$ declare blocked boolean:=false;p jsonb;begin
 begin perform public.discover_anon_compact_page_v1('22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444',0,20);
 exception when sqlstate 'CN001' then blocked:=true;end;
 if not blocked then raise exception 'Claim committed before read was accepted';end if;
 p:=public.discover_anon_compact_page_v1('33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555',0,20);
 if p->'anonymousClaimChecked' is distinct from 'true'::jsonb or p#>'{page,page_post_ids}' is distinct from '[]'::jsonb
  or p#>>'{page,total_count}' is distinct from '0' then raise exception 'Unclaimed empty page failed';end if;
end $$;commit;`;
const reader=`${tx}set local application_name='cn_claim_ci_reader';set local role service_role;
with started as materialized(select pg_backend_pid() as reader_pid,clock_timestamp() as reader_started_at,
 current_setting('transaction_isolation') as isolation),
 gate as materialized(select *,pg_sleep(4) from started),
 checked as materialized(select reader_pid,reader_started_at,isolation,
 public.discover_anon_compact_page_v1('33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555'::uuid,0,20) as checked_page from gate)
insert into public.__claim_probe_ci_receipts(kind,value)
select 'reader',to_jsonb(checked)||jsonb_build_object('reader_finished_at',clock_timestamp()) from checked;
commit;`;
const writer=`${tx}set local application_name='cn_claim_ci_writer';
select jsonb_build_object('phase','writer-started','at',clock_timestamp(),'pid',pg_backend_pid());
do $$ declare deadline timestamptz:=clock_timestamp()+interval '2 seconds';r record;n int;changed int;begin
 loop
  perform pg_stat_clear_snapshot();
  select count(*) into n from pg_stat_activity where datname=current_database() and application_name='cn_claim_ci_reader'
   and pid<>pg_backend_pid() and state='active' and wait_event_type='Timeout' and wait_event='PgSleep' and backend_xmin is not null;
  if n>1 then raise exception 'More than one sleeping reader';end if;
  if n=1 then
   select pid,backend_start,backend_xmin::text as xmin into r from pg_stat_activity
    where datname=current_database() and application_name='cn_claim_ci_reader' and pid<>pg_backend_pid()
     and state='active' and wait_event_type='Timeout' and wait_event='PgSleep' and backend_xmin is not null;
   if found then exit;end if;
  end if;
  if clock_timestamp()>=deadline then raise exception 'No distinct sleeping reader within bounded barrier';end if;
  perform pg_sleep(least(0.025,greatest(0,extract(epoch from deadline-clock_timestamp()))));
 end loop;
 insert into public.discover_identity_links_v1 values('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111');
 update public.discover_sessions_v1 set actor='user:11111111-1111-4111-8111-111111111111',user_id='11111111-1111-4111-8111-111111111111'
  where id='33333333-3333-4333-8333-333333333333' and actor='anon:55555555-5555-4555-8555-555555555555' and user_id is null and cardinality(post_ids)=0;
 get diagnostics changed=row_count;if changed<>1 then raise exception 'Owned empty session did not migrate';end if;
 insert into public.__claim_probe_ci_receipts values('writer',jsonb_build_object('writer_pid',pg_backend_pid(),
  'reader_pid',r.pid,'reader_backend_start',r.backend_start,'reader_backend_xmin',r.xmin,
  'writer_observed_reader_at',clock_timestamp(),'isolation',current_setting('transaction_isolation')));
end $$;commit;
${tx}select pg_stat_clear_snapshot();
insert into public.__claim_probe_ci_receipts(kind,value)
select 'witness',jsonb_build_object('writer_postcommit_witness_at',clock_timestamp(),'witness_pid',pg_backend_pid(),
 'committed_claim_visible',exists(select 1 from public.discover_identity_links_v1 where anonymous_id='55555555-5555-4555-8555-555555555555' and user_id='11111111-1111-4111-8111-111111111111'),
 'committed_owner_visible',exists(select 1 from public.discover_sessions_v1 where id='33333333-3333-4333-8333-333333333333' and actor='user:11111111-1111-4111-8111-111111111111' and user_id='11111111-1111-4111-8111-111111111111'),
 'reader_still_sleeping_after_commit',exists(select 1 from pg_stat_activity where pid=(value->>'reader_pid')::int and pid<>pg_backend_pid()
  and backend_start=(value->>'reader_backend_start')::timestamptz and datname=current_database() and application_name='cn_claim_ci_reader'
  and state='active' and wait_event_type='Timeout' and wait_event='PgSleep' and backend_xmin is not null))
from public.__claim_probe_ci_receipts where kind='writer';commit;`;
const after=`${tx}set local role service_role;
do $$ declare blocked boolean;p jsonb;candidate uuid;begin
 foreach candidate in array array['55555555-5555-4555-8555-555555555555'::uuid,'66666666-6666-4666-8666-666666666666'::uuid] loop
  blocked:=false;begin perform public.discover_anon_compact_page_v1('33333333-3333-4333-8333-333333333333',candidate,0,20);
  exception when sqlstate 'CN001' then blocked:=true;end;
  if not blocked then raise exception 'Claimed or foreign anonymous actor was accepted';end if;
 end loop;
 blocked:=false;begin perform public.discover_compact_page_v1('33333333-3333-4333-8333-333333333333','user:66666666-6666-4666-8666-666666666666',0,20);
 exception when sqlstate 'CN001' then blocked:=true;end;
 if not blocked then raise exception 'Foreign user actor was accepted';end if;
 p:=public.discover_compact_page_v1('33333333-3333-4333-8333-333333333333','user:11111111-1111-4111-8111-111111111111',0,20);
 if p->'page_post_ids' is distinct from '[]'::jsonb or p->>'total_count' is distinct from '0' then raise exception 'Owned account empty page failed';end if;
end $$;
select jsonb_object_agg(kind,value) from public.__claim_probe_ci_receipts;
commit;`;
const cleanup=`${tx}${environmentGuard.replace("current_database()<>'"+DB+"'","current_database()<>'postgres'")}
do $$ begin
 if not exists(select 1 from pg_database where datname='cn_claim_page_ci' and datdba=(select oid from pg_roles where rolname='postgres')
  and shobj_description(oid,'pg_database')='${MARKER}') then
  raise exception 'Missing or foreign disposable database marker; refuse cleanup';end if;
end $$;
-- Commit a connection fence before draining peers: even a docker exec client
-- killed before psql starts can no longer connect late and race schema cleanup.
alter database cn_claim_page_ci allow_connections false;
commit;
${tx}
do $$ declare deadline timestamptz:=clock_timestamp()+interval '2 seconds';begin
 perform pg_stat_clear_snapshot();
 if exists(select 1 from pg_stat_activity where datname='cn_claim_page_ci'
  and backend_type='client backend' and application_name not in('cn_claim_ci_control','cn_claim_ci_reader','cn_claim_ci_writer')) then
  raise exception 'Unexpected database peer; refuse destructive cleanup';end if;
 perform pg_terminate_backend(pid) from pg_stat_activity where datname='cn_claim_page_ci'
  and backend_type='client backend' and application_name in('cn_claim_ci_control','cn_claim_ci_reader','cn_claim_ci_writer');
 loop
  perform pg_stat_clear_snapshot();
  exit when not exists(select 1 from pg_stat_activity where datname='cn_claim_page_ci' and backend_type='client backend');
  if clock_timestamp()>=deadline then raise exception 'Probe database peers did not terminate; refuse destructive cleanup';end if;
  perform pg_sleep(0.025);
 end loop;
end $$;
create temporary table claim_ci_cleanup_receipt as select
 not datallowconn as connections_fenced,
 (select count(*) from pg_stat_activity where datname='cn_claim_page_ci' and backend_type='client backend') as other_client_backends
from pg_database where datname='cn_claim_page_ci';
do $$ begin
 if not exists(select 1 from claim_ci_cleanup_receipt where connections_fenced and other_client_backends=0) then
  raise exception 'Missing fenced zero-peer witness; refuse destructive cleanup';end if;
end $$;commit;
-- DROP DATABASE must run outside a transaction and from the maintenance DB.
drop database cn_claim_page_ci;
${tx}drop role service_role;drop role untrusted;drop role authenticated;drop role anon;
select jsonb_build_object('cleanup_complete',not exists(select 1 from pg_database where datname='cn_claim_page_ci'),
 'connections_fenced',connections_fenced,'other_client_backends',other_client_backends,
 'test_roles_remaining',(select count(*) from pg_roles where rolname in('service_role','untrusted','authenticated','anon'))) from claim_ci_cleanup_receipt;
commit;`;

function dockerCommand(container,env=process.env,platform=process.platform){
 if(platform!=='linux'||env.CI!=='true'||env.GITHUB_ACTIONS!=='true'||!/^([a-f0-9]{12}|[a-f0-9]{64})$/.test(container??''))
  throw Error('Requires Linux GitHub Actions and its exact disposable PostgreSQL service container ID');
 return {command:'docker',args:['--host','unix:///var/run/docker.sock','exec','--interactive','--env','PGAPPNAME=cn_claim_ci_control',container,
  'psql','--no-psqlrc','--no-password','--host=/var/run/postgresql','--port=5432','--username=postgres','--dbname='+DB,'--tuples-only','--no-align','--quiet','--set=ON_ERROR_STOP=1'],
  options:{shell:false,env:{PATH:env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']}};
}
function makeSqlRunner(command,spawnImpl=spawn){
 return (sql,scope)=>new Promise((resolve,reject)=>{
  if(scope!==undefined&&scope!=='maintenance'){reject(Error('Invalid local database scope'));return;}
  const args=scope==='maintenance'?command.args.map(arg=>arg==='--dbname='+DB?'--dbname=postgres':arg):command.args;
  const child=spawnImpl(command.command,args,command.options);let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),done=false,problem;
  const cancel=()=>{try{child.kill('SIGKILL');}catch{}};
  const deadline=setTimeout(()=>{problem=Error('Ephemeral psql process exceeded 15 seconds');cancel();},15000);
  function collect(kind,bytes){
   if(problem)return;
   const input=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes),room=262144-stdout.length-stderr.length;
   const part=input.subarray(0,Math.max(0,room));
   if(kind==='out')stdout=Buffer.concat([stdout,part]);else stderr=Buffer.concat([stderr,part]);
   if(input.length>room){problem=Error('Ephemeral psql output exceeded 256 KiB');cancel();}
  }
  child.stdout.on('data',bytes=>collect('out',bytes));child.stderr.on('data',bytes=>collect('err',bytes));
  function finish(error){if(done)return;done=true;clearTimeout(deadline);
   // Replacement characters can expand invalid/truncated UTF-8. Re-cap the
   // readable diagnostic by bytes, removing any incomplete final character.
   const prefix=bytes=>Buffer.from(bytes.toString('utf8')).subarray(0,bytes.length).toString('utf8').replace(/\uFFFD$/u,'');
   if(error){error.diagnostic={stdout:prefix(stdout),stderr:prefix(stderr)};reject(error);}else resolve(stdout.toString('utf8'));}
  child.on('error',error=>finish(error));child.on('close',(code,signal)=>finish(problem??(code===0?null:Error('Ephemeral psql failed: '+(signal??code)))));
  child.stdin.on('error',()=>{problem=Error('Ephemeral psql input closed');cancel();});child.stdin.end(sql);
 });
}
function jsonRows(output){return output.split(/\r?\n/).filter(line=>line.trim().startsWith('{')).map(line=>JSON.parse(line));}
function assertProof(proof){
 const {reader:r,writer:w,witness:v}=proof??{};assert.ok(r&&w&&v,'All three persisted receipts are required');
 assert.equal(r.isolation,'read committed');assert.equal(w.isolation,'read committed');
 assert.ok(Number.isInteger(r.reader_pid)&&Number.isInteger(w.writer_pid)&&Number.isInteger(v.witness_pid));
 assert.notEqual(w.writer_pid,r.reader_pid);assert.equal(w.reader_pid,r.reader_pid);assert.notEqual(v.witness_pid,r.reader_pid);
 assert.ok(w.reader_backend_start&&/^\d+$/.test(w.reader_backend_xmin));
 assert.equal(v.committed_claim_visible,true);assert.equal(v.committed_owner_visible,true);assert.equal(v.reader_still_sleeping_after_commit,true);
 const times=[r.reader_started_at,w.writer_observed_reader_at,v.writer_postcommit_witness_at,r.reader_finished_at].map(Date.parse);
 assert.ok(times.every(Number.isFinite)&&times[0]<=times[1]&&times[1]<=times[2]&&times[2]<times[3],'Committed witness must precede reader finish');
 assert.equal(r.checked_page.anonymousClaimChecked,true);assert.deepEqual(r.checked_page.page.page_post_ids,[]);assert.equal(r.checked_page.page.total_count,0);
 return proof;
}
async function runProbe({sql,scaffold,migrations}){
 assert.equal(migrations.length,3);let error,proof,cleaned;
 try{
  await sql(tx+environmentGuard+freshGuard+scaffold+'\n'+migrations.join('\n')+"\ncomment on database cn_claim_page_ci is '"+MARKER+"';commit;");
  await sql(before);
  // Start both actual local psql clients before awaiting either one's terminal result.
  const pair=await Promise.allSettled([sql(reader),sql(writer)]);
  const failed=pair.filter(result=>result.status==='rejected');
  if(failed.length)throw new AggregateError(failed.map(result=>result.reason),'Direct PostgreSQL overlap did not complete');
  proof=assertProof(jsonRows(await sql(after)).at(-1));
 }catch(cause){error=cause;}
 try{cleaned=jsonRows(await sql(cleanup,'maintenance')).at(-1);assert.equal(cleaned?.cleanup_complete,true);assert.equal(cleaned.test_roles_remaining,0);
  assert.equal(cleaned.connections_fenced,true);assert.equal(cleaned.other_client_backends,0);}
 catch(cause){error=new AggregateError([...(error?[error]:[]),cause],'Probe or guarded ephemeral cleanup failed');}
 if(error)throw error;
 return {status:'passed',proof,cleanup:cleaned,scope:'Real PostgreSQL snapshot/ownership test only; not application or capacity proof'};
}
async function main(){
 const command=dockerCommand(process.env.CLAIM_PROBE_POSTGRES_CONTAINER);
 const scaffold=fs.readFileSync(path.join(__dirname,'real-postgres-claim-scaffold.sql'),'utf8');
 const migrations=MIGRATIONS.map(name=>fs.readFileSync(path.join(process.cwd(),'supabase/migrations',name),'utf8'));
 const result=await runProbe({sql:makeSqlRunner(command),scaffold,migrations});
 result.migrations=MIGRATIONS.map((name,index)=>({name,sha256:createHash('sha256').update(migrations[index]).digest('hex')}));
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if(require.main===module)main().catch(error=>{
 const report=failure=>{if(failure instanceof AggregateError){for(const cause of failure.errors)report(cause);}else process.stderr.write(JSON.stringify({error:failure.message,diagnostic:failure.diagnostic??null})+'\n');};
 report(error);
 process.exitCode=1;
});
module.exports={MIGRATIONS,DB,dockerCommand,makeSqlRunner,assertProof,runProbe,sql:{environmentGuard,freshGuard,before,reader,writer,after,cleanup}};
