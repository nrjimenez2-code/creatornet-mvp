import { NextRequest } from 'next/server';
const owner='a1111111-1111-4111-8111-111111111111',id='b2222222-2222-4222-8222-222222222222';
const user={id:owner,is_anonymous:false,email_confirmed_at:'2026-01-01T00:00:00Z',phone_confirmed_at:null};
const actor={auth:{getUser:jest.fn(async()=>({data:{user},error:null}))}};
const begin=jest.fn(),status=jest.fn(),complete=jest.fn(),allow=jest.fn(()=>true);
const mockProfile=jest.fn(),mockLegacy=jest.fn(),mockHead=jest.fn();
const mockAdmit=jest.fn(async(...args:unknown[])=>({resource:(args[3] as {resource:string}).resource,reused:false}));
jest.mock('../lib/supabaseClient',()=>({createServerSupabase:async()=>actor}));
jest.mock('../lib/supabaseAdmin',()=>({supabaseAdmin:{from:()=>({select:()=>({eq:()=>({maybeSingle:mockProfile})})})}}));
jest.mock('../lib/abuse/admission',()=>({admitRequest:(...args:unknown[])=>mockAdmit(...args),admissionResponse:()=>null}));
jest.mock('../lib/legacyPublicUpload',()=>({hasLegacyPublicUploadReservation:(...args:unknown[])=>mockLegacy(...args)}));
jest.mock('../lib/r2',()=>({headR2Object:(...args:unknown[])=>mockHead(...args),r2PublicUrl:(key:string)=>'https://cdn.test/'+key}));
jest.mock('../lib/uploadTrackingProviders',()=>({StorageUploadTrackingProviders:jest.fn()}));
jest.mock('../lib/uploadTrackingStore',()=>({SupabaseUploadTrackingStore:jest.fn()}));
jest.mock('../lib/uploadTracking',()=>({UploadTrackingRuntime:jest.fn(()=>({begin,status,complete}))}));
jest.mock('../lib/rateLimit',()=>({allowRequest:()=>allow(),clientKey:()=>'local',tooManyRequests:()=>new Response('limited',{status:429})}));
import { POST as admit } from '../app/api/upload/admit/route';
import { POST as legacy } from '../app/api/upload/presign/route';
import { POST as reconcile,GET as read } from '../app/api/upload/[attemptId]/complete/route';
const req=(body:unknown)=>new NextRequest('http://localhost/api/upload/admit',{method:'POST',body:JSON.stringify(body)});
const ctx={params:Promise.resolve({attemptId:id})};
const media={purpose:'video',filename:'a.mp4',contentType:'video/mp4',size:10,attemptId:id,operationId:id,uploadContract:'create-only-v1'};
const old={...media,folder:'videos'};
beforeEach(()=>{
  jest.clearAllMocks();allow.mockReturnValue(true);actor.auth.getUser.mockResolvedValue({data:{user:{...user}},error:null});
  mockProfile.mockResolvedValue({data:{banned_at:null},error:null});mockLegacy.mockResolvedValue(true);mockHead.mockResolvedValue({size:10,contentType:'video/mp4'});
  mockAdmit.mockImplementation(async(...args:unknown[])=>({resource:(args[3] as {resource:string}).resource,reused:false}));
  begin.mockResolvedValue({attemptId:id,key:'key',capability:{provider:'r2',uploadUrl:'signed',publicUrl:'public'}});
  complete.mockResolvedValue({status:200,upload:{attemptId:id,objectObserved:true}});status.mockResolvedValue({attemptId:id});
});
test('private route preserves actor-owned normal Next context',async()=>{
  const response=await admit(req({purpose:'premium',filename:'a.pdf',contentType:'application/pdf',size:5,attemptId:id}));
  expect(response.status).toBe(200);expect(begin).toHaveBeenCalledWith(expect.objectContaining({purpose:'premium',expectedBytes:5,ownerId:owner}));expect(response.headers.get('Cache-Control')).toBe('no-store');expect(mockAdmit).not.toHaveBeenCalled();
});
test('fresh legacy issuance requires refresh without reservation, signing or inspection',async()=>{
  const response=await legacy(req(old));expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:'UPLOAD_CLIENT_REFRESH_REQUIRED'});
  expect(begin).not.toHaveBeenCalled();expect(mockAdmit).not.toHaveBeenCalled();expect(mockLegacy).not.toHaveBeenCalled();expect(mockHead).not.toHaveBeenCalled();expect(response.headers.get('Cache-Control')).toContain('no-store');
});
test('legacy continuation only verifies its exact retained original key without admission',async()=>{
  const response=await legacy(req({...old,verifyExisting:true}));const key='videos/'+owner+'/launch_'+id+'.mp4';
  expect(response.status).toBe(200);expect(await response.json()).toEqual({alreadyUploaded:true,key,publicUrl:'https://cdn.test/'+key});
  expect(mockLegacy).toHaveBeenCalledWith({ownerId:owner,operationId:id,folder:'videos',extension:'mp4',size:10,contentType:'video/mp4',key});expect(mockHead).toHaveBeenCalledWith(key);expect(begin).not.toHaveBeenCalled();expect(mockAdmit).not.toHaveBeenCalled();
});
test.each([false,'unavailable'])('legacy reservation %p fails closed before HEAD',async result=>{
  if(result===false)mockLegacy.mockResolvedValue(false);else mockLegacy.mockRejectedValue(Error('private details'));
  const response=await legacy(req({...old,verifyExisting:true}));expect(response.status).toBe(result===false?409:503);expect(mockHead).not.toHaveBeenCalled();expect(mockAdmit).not.toHaveBeenCalled();expect(begin).not.toHaveBeenCalled();expect(JSON.stringify(await response.json())).not.toContain('private details');
});
test.each([null,{size:11,contentType:'video/mp4'},{size:10,contentType:'image/jpeg'}])('legacy object mismatch %p never completes',async value=>{
  mockHead.mockResolvedValue(value);expect((await legacy(req({...old,verifyExisting:true}))).status).toBe(503);expect(begin).not.toHaveBeenCalled();expect(mockAdmit).not.toHaveBeenCalled();
});
test('legacy verification requires a supplied original operation',async()=>{
  expect((await legacy(req({...old,operationId:undefined,verifyExisting:true}))).status).toBe(400);expect(mockLegacy).not.toHaveBeenCalled();expect(mockHead).not.toHaveBeenCalled();
});
describe.each([{name:'legacy',run:legacy,legacyMode:true},{name:'new',run:admit,legacyMode:false}])('$name public-media MIME refusal',({run,legacyMode})=>{
  test.each([
    {purpose:'video',contentType:'text/html'},{purpose:'video',contentType:'image/svg+xml'},
    {purpose:'video',contentType:'image/jpeg'},{purpose:'video',contentType:undefined},
    {purpose:'thumbnail',contentType:'text/html'},{purpose:'thumbnail',contentType:'image/svg+xml'},
    {purpose:'thumbnail',contentType:'video/mp4'},{purpose:'thumbnail',contentType:'image/heic'},{purpose:'thumbnail',contentType:undefined},
  ])('rejects $purpose with $contentType before any capability',async({purpose,contentType})=>{
    const response=await run(req({...media,purpose,contentType,filename:purpose==='video'?'a.mp4':'a.jpg',...(legacyMode?{folder:purpose==='video'?'videos':'thumbnails',verifyExisting:true}:{})}));
    expect(response.status).toBe(400);expect(response.headers.get('Cache-Control')).toContain('no-store');expect(begin).not.toHaveBeenCalled();expect(mockAdmit).not.toHaveBeenCalled();expect(mockHead).not.toHaveBeenCalled();
  });
});
test('legacy purpose spoof cannot bypass its folder policy',async()=>{
  const response=await legacy(req({...old,purpose:'premium',filename:'a.html',contentType:'text/html',verifyExisting:true}));expect(response.status).toBe(400);expect(mockHead).not.toHaveBeenCalled();
});
test.each([{purpose:'video',contentType:'video/mp4',folder:'videos',extension:'mp4'},{purpose:'thumbnail',contentType:'image/jpeg',folder:'thumbnails',extension:'jpg'}])('new $purpose preserves normalized create-only admission',async value=>{
  expect((await admit(req({...media,...value,filename:'a.'+value.extension}))).status).toBe(200);
  expect(mockAdmit).toHaveBeenCalledWith(expect.anything(),'public_upload','user:'+owner,expect.objectContaining({operation:'public:'+owner+':'+id,resource:value.folder+'/'+owner+'/launch_'+id+'.'+value.extension,bytes:10}));
  expect(begin).toHaveBeenCalledWith(expect.objectContaining({purpose:value.purpose,contentType:value.contentType,ownerId:owner,expectedBytes:10}));
});
test.each([{is_anonymous:true},{email_confirmed_at:null}])('unverified/anonymous account %p cannot admit public uploads',async change=>{
  actor.auth.getUser.mockResolvedValue({data:{user:{...user,...change}},error:null} as unknown as Awaited<ReturnType<typeof actor.auth.getUser>>);
  expect((await admit(req(media))).status).toBe(403);expect(mockAdmit).not.toHaveBeenCalled();expect(begin).not.toHaveBeenCalled();
});
test.each([{data:null,error:null},{data:{banned_at:'2026-01-01'},error:null},{data:null,error:{message:'unavailable'}}])('profile %p refuses before public admission',async result=>{
  mockProfile.mockResolvedValue(result);expect((await admit(req(media))).status).toBe(403);expect(mockAdmit).not.toHaveBeenCalled();expect(begin).not.toHaveBeenCalled();
});
test('public admission requires explicit contract and resource match',async()=>{
  expect((await admit(req({...media,uploadContract:undefined}))).status).toBe(409);expect(mockAdmit).not.toHaveBeenCalled();
  mockAdmit.mockResolvedValue({resource:'other',reused:false});expect((await admit(req(media))).status).toBe(503);expect(begin).not.toHaveBeenCalled();
});
test.each([undefined,null,0,1.5])('new endpoint refuses size %p before quota/signing',async size=>{
  expect((await admit(req({...media,size}))).status).toBe(400);expect(mockAdmit).not.toHaveBeenCalled();expect(begin).not.toHaveBeenCalled();
});
test('all endpoints authenticate before resolving uploads',async()=>{
  actor.auth.getUser.mockResolvedValue({data:{user:null},error:null} as unknown as Awaited<ReturnType<typeof actor.auth.getUser>>);
  expect((await admit(req({}))).status).toBe(401);expect((await legacy(req(old))).status).toBe(401);expect((await reconcile(req({outcome:'uploaded'}),ctx)).status).toBe(401);expect(complete).not.toHaveBeenCalled();
});
test('browser metadata, owner, key or bucket cannot enter completion',async()=>{
  for(const extra of [{size:1},{metadata:{size:1}},{ownerId:owner},{bucket:'premium'},{key:'other'}])expect((await reconcile(req({outcome:'uploaded',...extra}),ctx)).status).toBe(400);expect(complete).not.toHaveBeenCalled();
});
test('completion and read stay owner-scoped and independent of admission/profile gates',async()=>{
  mockProfile.mockResolvedValue({data:null,error:null});mockAdmit.mockRejectedValue(Error('paused'));
  expect((await reconcile(req({outcome:'uploaded'}),ctx)).status).toBe(200);expect(complete).toHaveBeenCalledWith(id,owner,'uploaded');
  expect((await read(req({}),ctx)).headers.get('Cache-Control')).toBe('no-store');expect(status).toHaveBeenCalledWith(id,owner);expect(mockAdmit).not.toHaveBeenCalled();expect(mockProfile).not.toHaveBeenCalled();
});
test('provider/database failures return generic text without capabilities',async()=>{
  begin.mockRejectedValue(Error('https://secret.invalid?token=hidden'));const response=await admit(req(media));expect(response.status).toBe(503);expect(JSON.stringify(await response.json())).not.toContain('hidden');
});
test('shared process admission limit prevents signing',async()=>{
  allow.mockReturnValue(false);expect((await legacy(req({}))).status).toBe(429);expect((await admit(req(media))).status).toBe(429);expect(begin).not.toHaveBeenCalled();expect(mockAdmit).not.toHaveBeenCalled();
});
