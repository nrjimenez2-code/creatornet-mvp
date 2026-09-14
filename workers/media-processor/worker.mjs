const ACCOUNT = '09c059503967a4e861c32fa0d5b06ee0';
const BUCKET = 'creatornet-media';
const ORIGIN = 'https://media.creatornet.net';
const MAX_BYTES = 500 * 1024 * 1024;
export const validKey = key => typeof key === 'string' && /^videos\/[a-zA-Z0-9_/-]+\.(mp4|mov|webm|m4v|mpeg|mpg|3gp|mkv)$/i.test(key) && !key.includes('..');
const hex = bytes => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
const digest = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then(hex);
const json = async (bucket, key) => { const object = await bucket.get(key); return object ? object.json() : null; };
const save = (bucket, key, value) => bucket.put(key, JSON.stringify(value), {httpMetadata:{contentType:'application/json'}});
const cleanEtag = e => String(e || '').replaceAll('"', '');

export async function processMessage(message, env) {
  const event = message.body;
  const key = event?.object?.key;
  if (event?.account !== ACCOUNT || event.bucket !== BUCKET || !['PutObject','CopyObject','CompleteMultipartUpload'].includes(event.action) || !validKey(key)) { message.ack(); return; }
  const head = await env.MEDIA.head(key);
  if (!head || head.size > MAX_BYTES || head.size < 1 || head.etag !== cleanEtag(event.object.eTag)) { message.ack(); return; }
  const id = await digest(key + '\n' + head.etag);
  const stateKey = 'jobs/' + id + '.json';
  let state = await json(env.STATE, stateKey);
  if (state?.phase === 'done' || state?.phase === 'failed') { message.ack(); return; }
  const persist = async () => { state.updatedAt = new Date().toISOString(); await save(env.STATE, stateKey, state); };
  const later = () => message.retry({delaySeconds:60});
  if (!state) {
    state = {id,key,etag:head.etag,phase:'submitting',createdAt:new Date().toISOString()};
    // Durable intent precedes the external call. Ambiguous responses are reconciled, never blindly re-imported.
    const claim = await env.STATE.put(stateKey, JSON.stringify(state), {onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
    if (!claim) { later(); return; }
    try {
      const video = await env.STREAM.upload(ORIGIN + '/' + key, {meta:{name:'creatornet-auto-'+id,creatornetJob:id},requireSignedURLs:false});
      state.streamId = video.id;
      state.phase = 'encoding';
      await persist();
    } catch (error) {
      state.lastError = String(error?.name || 'ImportError');
      // Explicit validation failures cannot have produced a usable video. Keep originals available.
      if (['BadRequestError','MaxFileSizeError'].includes(state.lastError)) {state.phase='failed';await persist();console.error(JSON.stringify({event:'media_failed',job:id,reason:state.lastError}));message.ack();return;}
      await persist();
      console.error(JSON.stringify({event:'media_import_needs_reconciliation',job:id,reason:state.lastError}));
      later(); return;
    }
  }
  if (!state.streamId) {
    const videos = await env.STREAM.videos.list({after:new Date(Date.parse(state.createdAt)-60000).toISOString(),limit:1000});
    const matches = videos.filter(video => video.meta?.creatornetJob === id);
    if (matches.length !== 1) {console.error(JSON.stringify({event:'media_reconciliation_pending',job:id,matches:matches.length}));later();return;}
    state.streamId=matches[0].id;state.phase='encoding';await persist();
  }
  const video = env.STREAM.video(state.streamId);
  if (!state.outputKey) {
    const details = await video.details();
    if (details.meta?.creatornetJob !== id) throw new Error('Stream job identity mismatch');
    if (details.status?.state === 'error') {state.phase='failed';state.lastError='EncodingError';await persist();console.error(JSON.stringify({event:'media_failed',job:id,reason:'EncodingError'}));message.ack();return;}
    if (!details.readyToStream) {later();return;}
    state.durationSeconds = Number.isFinite(details.duration) && details.duration > 0 ? details.duration : null;
    let downloads = await video.downloads.get();
    if (!downloads.default) downloads = await video.downloads.generate('default');
    const download=downloads.default;
    if (download?.status !== 'ready' || !download.url) {later();return;}
    const url=new URL(download.url);
    if(url.protocol!=='https:' || !(url.hostname.endsWith('.cloudflarestream.com') || url.hostname==='videodelivery.net')) throw new Error('Unexpected download origin');
    const outputKey='feed-auto/'+id+'.mp4';
    let output = await env.MEDIA.head(outputKey);
    if (!output) {
      const response=await fetch(url,{signal:AbortSignal.timeout(60000)});
      const length=Number(response.headers.get('content-length'));
      if(!response.ok || !response.body || !Number.isSafeInteger(length) || length<1 || length>MAX_BYTES) {await response.body?.cancel();throw new Error('Invalid processed download');}
      // Stream directly into R2; never buffer a whole video in Worker memory.
      await env.MEDIA.put(outputKey,response.body,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'video/mp4',cacheControl:'public, max-age=31536000, immutable'}});
      output=await env.MEDIA.head(outputKey);
      if(!output || output.size!==length)throw new Error('Processed copy verification failed');
    }
    state.outputKey=outputKey;state.outputBytes=output.size;state.phase='publishing';await persist();
  }
  const current=await env.MEDIA.head(key);
  // An overwritten/deleted source must never receive a stale rendition pointer.
  if(!current || current.etag!==state.etag){state.phase='done';state.obsolete=true;await persist();message.ack();return;}
  await save(env.STATE,'ready/'+key+'.json',{etag:state.etag,outputKey:state.outputKey,durationSeconds:state.durationSeconds??null});
  state.phase='done';await persist();
  console.log(JSON.stringify({event:'media_ready',job:id,bytes:state.outputBytes}));
  message.ack();
}

export default {
  async queue(batch,env){
    for(const message of batch.messages){try{await processMessage(message,env);}catch(error){console.error(JSON.stringify({event:'media_retry',reason:String(error?.message||'Processing error')}));message.retry({delaySeconds:60});}}
  },
  async fetch(request,env){
    const url=new URL(request.url);
    if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
    if(url.pathname==='/auto/health')return Response.json({ok:true,version:1});
    const metadata = url.pathname.startsWith('/auto/metadata/');
    const key=metadata?url.pathname.slice('/auto/metadata/'.length):url.pathname.startsWith('/auto/')?url.pathname.slice(6):'';
    if(!validKey(key)||url.search)return new Response('Not found',{status:404});
    let target=ORIGIN+'/'+key;
    try{
      const ready=await json(env.STATE,'ready/'+key+'.json');
      if(ready && /^feed-auto\/[a-f0-9]{64}\.mp4$/.test(ready.outputKey)){
        const head=await env.MEDIA.head(key);
        if(head?.etag===ready.etag){
          if(metadata && !(Number.isFinite(ready.durationSeconds) && ready.durationSeconds>0)){
            const id=await digest(key+'\n'+head.etag);
            const job=await json(env.STATE,'jobs/'+id+'.json');
            if(job?.streamId){
              const details=await env.STREAM.video(job.streamId).details();
              if(details.meta?.creatornetJob===id && Number.isFinite(details.duration) && details.duration>0){
                ready.durationSeconds=details.duration;
                await save(env.STATE,'ready/'+key+'.json',ready);
              }
            }
          }
          if(metadata && Number.isFinite(ready.durationSeconds) && ready.durationSeconds>0)
            return Response.json({key,etag:ready.etag,durationSeconds:ready.durationSeconds},{headers:{'Cache-Control':'no-store'}});
          target=ORIGIN+'/'+ready.outputKey;
        }
      }
    }catch{ /* Original playback is available even if the state store is unavailable. */ }
    if(metadata)return Response.json({error:'Verified metadata unavailable'},{status:404,headers:{'Cache-Control':'no-store'}});
    return new Response(null,{status:302,headers:{Location:target,'Cache-Control':'public, max-age=30','X-Content-Type-Options':'nosniff'}});
  }
};
