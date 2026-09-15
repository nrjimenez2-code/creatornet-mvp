import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker,{processMessage,validKey} from './worker.mjs';

class Bucket {
  objects=new Map();
  async get(k){const v=this.objects.get(k);return v?{json:async()=>JSON.parse(v.body)}:null;}
  async head(k){return this.objects.get(k)||null;}
  async put(k,body,options={}){if(options.onlyIf&&this.objects.has(k))return null; const v={body,etag:'etag',size:typeof body==='string'?body.length:4};this.objects.set(k,v);return v;}
}
function fixture(){
  const MEDIA=new Bucket(),STATE=new Bucket();MEDIA.objects.set('videos/test.mp4',{etag:'source',size:4});
  let uploads=0,ready=false,error=false,ambiguous=false,meta;
  const STREAM={upload:async(url,options)=>{uploads++;meta=options.meta;if(ambiguous)throw Error('timeout');return{id:'stream1'};},videos:{list:async()=>[{id:'stream1',meta}]},video:()=>({details:async()=>({meta,readyToStream:ready,status:{state:error?'error':'ready'}}),downloads:{get:async()=>({default:{status:'ready',url:'https://customer-test.cloudflarestream.com/download.mp4'}})}})};
  const env={MEDIA,STATE,STREAM};
  const msg=()=>({body:{account:'09c059503967a4e861c32fa0d5b06ee0',bucket:'creatornet-media',action:'PutObject',object:{key:'videos/test.mp4',eTag:'source'}},acked:false,retried:false,ack(){this.acked=true},retry(){this.retried=true}});
  return {env,msg,get uploads(){return uploads},set ready(v){ready=v},set error(v){error=v},set ambiguous(v){ambiguous=v}};
}
test('only supported public video paths',()=>{for(const k of ['premium/a.mp4','videos/../private.mp4','videos/a.mp4?x','https://x/a.mp4'])assert.equal(validKey(k),false);assert.equal(validKey('videos/uuid-file.mp4'),true)});
test('duplicates do not repeat Stream import while encoding',async()=>{const f=fixture();const a=f.msg();await processMessage(a,f.env);await processMessage(f.msg(),f.env);assert.equal(f.uploads,1);assert(a.retried)});
test('ambiguous import is reconciled without importing again',async()=>{const f=fixture();f.ambiguous=true;await processMessage(f.msg(),f.env);await processMessage(f.msg(),f.env);assert.equal(f.uploads,1);assert.equal([...f.env.STATE.objects.values()].map(v=>JSON.parse(v.body))[0].streamId,'stream1')});
test('foreign events and stale ETags never import',async()=>{const f=fixture();for(const field of ['account','bucket']){const m=f.msg();m.body[field]='foreign';await processMessage(m,f.env);assert(m.acked)}const m=f.msg();m.body.object.eTag='old';await processMessage(m,f.env);assert.equal(f.uploads,0)});
test('encoding failures preserve original and publish no pointer',async()=>{const f=fixture();f.error=true;const m=f.msg();await processMessage(m,f.env);assert(m.acked);assert(await f.env.MEDIA.head('videos/test.mp4'));assert.equal(await f.env.STATE.get('ready/videos/test.mp4.json'),null)});
test('completed output routes to copy; duplicate completes without upload; overwrite falls back',async()=>{const f=fixture();f.ready=true;const old=globalThis.fetch;globalThis.fetch=async()=>new Response(new Uint8Array(4),{headers:{'content-length':'4'}});try{const m=f.msg();await processMessage(m,f.env);assert(m.acked);await processMessage(f.msg(),f.env);assert.equal(f.uploads,1);let r=await worker.fetch(new Request('https://media.creatornet.net/auto/videos/test.mp4'),f.env);assert.match(r.headers.get('location'),/\/feed-auto\/[a-f0-9]{64}\.mp4$/);f.env.MEDIA.objects.set('videos/test.mp4',{etag:'changed',size:4});r=await worker.fetch(new Request('https://media.creatornet.net/auto/videos/test.mp4'),f.env);assert.equal(r.headers.get('location'),'https://media.creatornet.net/videos/test.mp4')}finally{globalThis.fetch=old}});
test('unprocessed public video redirects to original; private paths are rejected',async()=>{const f=fixture();let r=await worker.fetch(new Request('https://media.creatornet.net/auto/videos/test.mp4'),f.env);assert.equal(r.status,302);assert.equal(r.headers.get('location'),'https://media.creatornet.net/videos/test.mp4');r=await worker.fetch(new Request('https://media.creatornet.net/auto/premium/test.mp4'),f.env);assert.equal(r.status,404)});

test('duration metadata is returned only for the current processed source',async()=>{
 const f=fixture(),key='ready/videos/test.mp4.json';
 await f.env.STATE.put(key,JSON.stringify({etag:'source',outputKey:'feed-auto/'+'a'.repeat(64)+'.mp4',durationSeconds:12.5}));
 const request=new Request('https://media.creatornet.net/auto/metadata/videos/test.mp4');
 let response=await worker.fetch(request,f.env);
 assert.equal(response.status,200);assert.equal((await response.json()).durationSeconds,12.5);
 f.env.MEDIA.objects.set('videos/test.mp4',{etag:'replacement',size:4});
 response=await worker.fetch(request,f.env);assert.equal(response.status,404);
 assert.equal(response.headers.get('location'),null);
});

test('legacy processed video recovers duration only from its matching Stream job',async()=>{
 const f=fixture(),key='ready/videos/test.mp4.json';
 const id=createHash('sha256').update('videos/test.mp4\nsource').digest('hex');
 await f.env.STATE.put(key,JSON.stringify({etag:'source',outputKey:'feed-auto/'+id+'.mp4'}));
 await f.env.STATE.put('jobs/'+id+'.json',JSON.stringify({streamId:'legacy-video'}));
 let reads=0,matching=false;
 f.env.STREAM.video=streamId=>({details:async()=>{assert.equal(streamId,'legacy-video');reads++;return {meta:{creatornetJob:matching?id:'foreign'},duration:15};}});
 const request=new Request('https://media.creatornet.net/auto/metadata/videos/test.mp4');
 assert.equal((await worker.fetch(request,f.env)).status,404);
 matching=true;
 assert.equal((await (await worker.fetch(request,f.env)).json()).durationSeconds,15);
 assert.equal((await (await worker.fetch(request,f.env)).json()).durationSeconds,15);
 assert.equal(reads,2);
});

function processedFixture() {
 const f=fixture();
 const key='ready/videos/test.mp4.json';
 const record={etag:'source',outputKey:'feed-auto/'+'a'.repeat(64)+'.mp4',durationSeconds:12.5};
 f.env.STATE.objects.set(key,{body:JSON.stringify(record)});
 return {...f,record,key,request:()=>new Request('https://media.creatornet.net/auto/metadata/videos/test.mp4')};
}

test('reuses a completed record but checks source deletion and replacement on every request',async()=>{
 const f=processedFixture();let reads=0,heads=0;
 const get=f.env.STATE.get.bind(f.env.STATE),head=f.env.MEDIA.head.bind(f.env.MEDIA);
 f.env.STATE.get=async key=>{reads++;return get(key)};
 f.env.MEDIA.head=async key=>{heads++;return head(key)};
 assert.equal((await worker.fetch(f.request(),f.env)).status,200);
 assert.equal((await worker.fetch(f.request(),f.env)).status,200);
 assert.equal(reads,1);assert.equal(heads,2);
 f.env.MEDIA.objects.delete('videos/test.mp4');
 assert.equal((await worker.fetch(f.request(),f.env)).status,404);
 f.env.MEDIA.objects.set('videos/test.mp4',{etag:'replacement',size:4});
 assert.equal((await worker.fetch(f.request(),f.env)).status,404);
 await f.env.STATE.put(f.key,JSON.stringify({...f.record,etag:'replacement',durationSeconds:22}));
 const response=await worker.fetch(f.request(),f.env);
 assert.equal(response.status,200);assert.equal((await response.json()).durationSeconds,22);
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(heads,5);
});

test('a replacement ready record is used immediately even while the old entry is cached',async()=>{
 const f=processedFixture();await worker.fetch(f.request(),f.env);
 f.env.MEDIA.objects.set('videos/test.mp4',{etag:'replacement',size:4});
 await f.env.STATE.put(f.key,JSON.stringify({...f.record,etag:'replacement',durationSeconds:30}));
 assert.equal((await (await worker.fetch(f.request(),f.env)).json()).durationSeconds,30);
});

test('cache expiry is fixed rather than extended by hits and does not cross state bindings',async t=>{
 let now=1000;t.mock.method(Date,'now',()=>now);
 const f=processedFixture(),other=processedFixture();
 assert.equal((await (await worker.fetch(f.request(),f.env)).json()).durationSeconds,12.5);
 await f.env.STATE.put(f.key,JSON.stringify({...f.record,durationSeconds:20}));
 await other.env.STATE.put(other.key,JSON.stringify({...other.record,durationSeconds:40}));
 now=30000;
 assert.equal((await (await worker.fetch(f.request(),f.env)).json()).durationSeconds,12.5);
 assert.equal((await (await worker.fetch(other.request(),other.env)).json()).durationSeconds,40);
 now=31000;
 assert.equal((await (await worker.fetch(f.request(),f.env)).json()).durationSeconds,20);
});

test('missing metadata and storage failures are not retained; source-read failures fail closed',async()=>{
 const f=processedFixture();f.env.STATE.objects.delete(f.key);
 assert.equal((await worker.fetch(f.request(),f.env)).status,404);
 await f.env.STATE.put(f.key,JSON.stringify(f.record));
 const get=f.env.STATE.get.bind(f.env.STATE);let fail=true;
 f.env.STATE.get=async key=>{if(fail)throw Error('unavailable');return get(key)};
 assert.equal((await worker.fetch(f.request(),f.env)).status,404);
 fail=false;assert.equal((await worker.fetch(f.request(),f.env)).status,200);
 f.env.MEDIA.head=async()=>{throw Error('unavailable')};
 assert.equal((await worker.fetch(f.request(),f.env)).status,404);
});

test('metadata starts independent storage reads together and bounds retained ready records',async()=>{
 const f=processedFixture();let headStarted=false;
 const get=f.env.STATE.get.bind(f.env.STATE),head=f.env.MEDIA.head.bind(f.env.MEDIA);
 f.env.STATE.get=async key=>{await Promise.resolve();assert(headStarted);return get(key)};
 f.env.MEDIA.head=async key=>{headStarted=true;return head(key)};
 assert.equal((await worker.fetch(f.request(),f.env)).status,200);
 let reads=0;f.env.STATE.get=async key=>{reads++;return get(key)};
 for(let index=0;index<1024;index++){
   const key='videos/cache-'+index+'.mp4';
   f.env.MEDIA.objects.set(key,{etag:'source',size:4});
   await f.env.STATE.put('ready/'+key+'.json',JSON.stringify(f.record));
   assert.equal((await worker.fetch(new Request('https://media.creatornet.net/auto/metadata/'+key),f.env)).status,200);
 }
 const previous=reads;
 assert.equal((await worker.fetch(f.request(),f.env)).status,200);
 assert.equal(reads,previous+1);
});
