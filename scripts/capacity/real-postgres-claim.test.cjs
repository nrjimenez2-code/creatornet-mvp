'use strict';
// Offline assertions only. No process execution, database or credentials.
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {dockerCommand,makeSqlRunner,assertProof,runProbe,sql,MIGRATIONS}=require('./real-postgres-claim.cjs');
const container='a'.repeat(64),env={CI:'true',GITHUB_ACTIONS:'true',PATH:'/usr/bin',DATABASE_URL:'must-not-forward',DOCKER_HOST:'must-not-forward',PGHOST:'must-not-forward'};
const clean=()=>JSON.stringify({cleanup_complete:true,test_roles_remaining:0,connections_fenced:true,other_client_backends:0});
const proof=()=>({reader:{reader_pid:100,isolation:'read committed',reader_started_at:'2026-09-16T10:00:00Z',reader_finished_at:'2026-09-16T10:00:04Z',checked_page:{anonymousClaimChecked:true,page:{page_post_ids:[],total_count:0}}},
 writer:{writer_pid:101,reader_pid:100,reader_backend_start:'2026-09-16T09:00:00Z',reader_backend_xmin:'20',writer_observed_reader_at:'2026-09-16T10:00:01Z',isolation:'read committed'},
 witness:{witness_pid:101,writer_postcommit_witness_at:'2026-09-16T10:00:02Z',committed_claim_visible:true,committed_owner_visible:true,reader_still_sleeping_after_commit:true}});
test('local Docker transport rejects non-CI, remote arguments and unsafe container IDs before spawning',()=>{
 const command=dockerCommand(container,env,'linux');
 assert.deepEqual(command.args.slice(0,7),['--host','unix:///var/run/docker.sock','exec','--interactive','--env','PGAPPNAME=cn_claim_ci_control',container]);
 assert.ok(command.args.includes('--host=/var/run/postgresql'));assert.ok(command.args.includes('--port=5432'));
 assert.ok(command.args.includes('--dbname=cn_claim_page_ci'));assert.ok(command.args.includes('--no-password'));
 assert.equal(command.options.shell,false);assert.deepEqual(command.options.env,{PATH:'/usr/bin',LANG:'C.UTF-8'});
 for(const id of ['postgres','-evil',container+';echo unsafe','https://example.invalid',undefined])assert.throws(()=>dockerCommand(id,env,'linux'));
 assert.throws(()=>dockerCommand(container,{...env,CI:'false'},'linux'));assert.throws(()=>dockerCommand(container,env,'win32'));
});
test('each SQL invocation starts an independent child with SQL on stdin and bounded output',async()=>{
 const calls=[];const spawn=(...args)=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
  child.kill=()=>queueMicrotask(()=>child.emit('close',null,'SIGKILL'));
  child.stdin.end=input=>{calls.push({args,input});queueMicrotask(()=>{child.stdout.emit('data',Buffer.from('{"synthetic":true}\n'));child.emit('close',0);});};return child;};
 const run=makeSqlRunner(dockerCommand(container,env,'linux'),spawn);await Promise.all([run(sql.reader),run(sql.writer)]);await run(sql.cleanup,'maintenance');
 assert.equal(calls.length,3);assert.equal(calls[0].input,sql.reader);assert.equal(calls[1].input,sql.writer);
 assert.ok(calls[2].args[1].includes('--dbname=postgres'));await assert.rejects(run('select 1;','arbitrary'));
 assert.ok(calls.every(call=>!call.args[1].includes(call.input)));
});
test('proof rejects same connection, absent commit witness, late witness and unverified page',()=>{
 assert.equal(assertProof(proof()).reader.reader_pid,100);
 const alterations=[p=>p.writer.writer_pid=100,p=>p.writer.reader_pid=102,p=>p.writer.reader_backend_xmin=null,
  p=>p.witness.witness_pid=100,p=>p.witness.committed_claim_visible=false,p=>p.witness.committed_owner_visible=false,
  p=>p.witness.reader_still_sleeping_after_commit=false,p=>p.witness.writer_postcommit_witness_at='2026-09-16T10:00:05Z',
  p=>p.reader.checked_page.anonymousClaimChecked=false,p=>p.reader.checked_page.page.page_post_ids=['invented'],p=>delete p.reader];
 for(const change of alterations){const p=proof();change(p);assert.throws(()=>assertProof(p));}
});
test('oversized ASCII and multibyte stdout/stderr retain at most 256 KiB and fail closed',async()=>{
 for(const [output,errorOutput] of [[Buffer.alloc(300000,65),Buffer.alloc(0)],[Buffer.from('\u6f22'.repeat(100000)),Buffer.alloc(0)],
  [Buffer.from('\u{1F642}'.repeat(30000)),Buffer.from('\u6f22'.repeat(70000))],[Buffer.alloc(200000,255),Buffer.alloc(100000,255)]]){
  let killed=false;
 const spawn=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
  child.kill=()=>{killed=true;queueMicrotask(()=>child.emit('close',null,'SIGKILL'));};
  child.stdin.end=()=>queueMicrotask(()=>{child.stdout.emit('data',output);child.stderr.emit('data',errorOutput);child.stdout.emit('data',Buffer.alloc(300000,65));});return child;};
 await assert.rejects(makeSqlRunner(dockerCommand(container,env,'linux'),spawn)('select 1;'),error=>{
  assert.match(error.message,/exceeded 256 KiB/);assert.ok(Buffer.byteLength(error.diagnostic.stdout)+Buffer.byteLength(error.diagnostic.stderr)<=262144);return true;
 });assert.equal(killed,true);}
});
test('actual migration contents are inputs; both clients dispatch before either is awaited, then cleanup',async()=>{
 const calls=[];let finishReader;
 const result=await runProbe({scaffold:'-- owned scaffold',migrations:MIGRATIONS.map((_,i)=>'-- actual migration '+i),sql:async(query,scope)=>{
  calls.push(query);
  if(query===sql.reader)return new Promise(resolve=>{finishReader=resolve;});
  if(query===sql.writer){assert.equal(typeof finishReader,'function');finishReader('');return '';}
  if(query===sql.after)return JSON.stringify(proof());
  if(query===sql.cleanup){assert.equal(scope,'maintenance');return clean();}return '';
 }});
 assert.equal(result.status,'passed');assert.match(calls[0],/actual migration 0/);assert.match(calls[0],/actual migration 2/);
 assert.equal(calls.at(-1),sql.cleanup);assert.equal(calls.length,6);
});
test('a failed writer still waits for reader settlement and cleans once, with no retry or pass',async()=>{
 let readerSettled=false,cleanupCount=0,writerCount=0;
 await assert.rejects(runProbe({scaffold:'',migrations:['','',''],sql:async query=>{
  if(query===sql.reader){await new Promise(resolve=>setImmediate(resolve));readerSettled=true;return '';}
  if(query===sql.writer){writerCount++;throw Error('no observed reader');}
  if(query===sql.cleanup){cleanupCount++;assert.equal(readerSettled,true);return clean();}return '';
 }}),/overlap did not complete/);assert.equal(cleanupCount,1);assert.equal(writerCount,1);
});
test('cleanup failure cannot be reported as a successful probe',async()=>{
 await assert.rejects(runProbe({scaffold:'',migrations:['','',''],sql:async query=>{
  if(query===sql.after)return JSON.stringify(proof());if(query===sql.cleanup)return JSON.stringify({cleanup_complete:false,test_roles_remaining:4});return '';
 }}),/cleanup failed/);
});
test('unknown or surviving peers and missing connection fence prevent cleanup success',async()=>{
 for(const outcome of [Error('Unexpected database peer; refuse destructive cleanup'),
  Error('Probe database peers did not terminate; refuse destructive cleanup'),
  {cleanup_complete:true,test_roles_remaining:0,connections_fenced:false,other_client_backends:0},
  {cleanup_complete:true,test_roles_remaining:0,connections_fenced:true,other_client_backends:1}]){
  await assert.rejects(runProbe({scaffold:'',migrations:['','',''],sql:async query=>{
   if(query===sql.after)return JSON.stringify(proof());if(query===sql.cleanup){if(outcome instanceof Error)throw outcome;return JSON.stringify(outcome);}return '';
  }}),/cleanup failed/);
 }
 const fence=sql.cleanup.indexOf('allow_connections false'),commit=sql.cleanup.indexOf('commit;',fence);
 const drain=sql.cleanup.indexOf('Probe database peers did not terminate'),drop=sql.cleanup.indexOf('drop database cn_claim_page_ci');
 assert.ok(fence>=0&&commit>fence&&drain>commit&&drop>drain);
 assert.match(sql.cleanup,/application_name in\('cn_claim_ci_control','cn_claim_ci_reader','cn_claim_ci_writer'\)/);
});
test('SQL retains service-role checks, actual post-COMMIT witness and bounded waits',()=>{
 assert.match(sql.before,/set local role service_role/);assert.match(sql.reader,/set local role service_role/);assert.match(sql.after,/set local role service_role/);
 assert.match(sql.reader,/pg_sleep\(4\)/);assert.match(sql.writer,/interval '2 seconds'/);assert.match(sql.writer,/end \$\$;commit;/);
 assert.match(sql.writer,/reader_still_sleeping_after_commit/);assert.match(sql.writer,/backend_start=\(value->>'reader_backend_start'\)::timestamptz/);
 assert.match(sql.cleanup,/foreign disposable database marker/);assert.match(sql.cleanup,/current_database\(\)<>'postgres'/);
 assert.ok(!Object.values(sql).join('\n').includes('link_discover_identity_v1'));
});
