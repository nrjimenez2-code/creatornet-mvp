import { POST } from "@/app/api/search/perform/route";
import { GET } from "@/app/api/search/suggest/route";
import { _resetRateLimits } from "@/lib/rateLimit";
import { EMPTY_SEARCH } from "@/lib/searchTypes";
const mockRpc=jest.fn();
const mockFrom=jest.fn();
jest.mock("@/lib/supabaseAdmin",()=>({supabaseAdmin:{rpc:(...args:unknown[])=>mockRpc(...args),from:(...args:unknown[])=>mockFrom(...args)}}));
const request=(body:unknown)=>new Request('https://example.invalid/api/search/perform',{method:'POST',body:JSON.stringify(body)});
beforeEach(()=>{_resetRateLimits();mockRpc.mockReset().mockResolvedValue({data:EMPTY_SEARCH,error:null});mockFrom.mockReset();});
test.each([{}, {q:null},{q:42},{q:[]},{q:'a'.repeat(161)},{q:'x',page:-1},{q:'x',page:1.5}])('invalid query does not reach database: %p',async body=>{
  expect((await POST(request(body))).status).toBe(400);expect(mockRpc).not.toHaveBeenCalled();
});

test('malformed JSON returns a fixed validation message without request fragments',async()=>{
  const res=await POST(new Request('https://example.invalid/api/search/perform',{method:'POST',body:'private-request-fragment'}));
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({error:'Enter a valid search of up to 160 characters and a valid page.'});
  expect(mockRpc).not.toHaveBeenCalled();
});

test('search and suggestion rate limits reject excess requests before database work',async()=>{
  for(let i=0;i<60;i++) expect((await POST(request({q:'ecom'}))).status).toBe(200);
  mockRpc.mockClear();
  expect((await POST(request({q:'ecom'}))).status).toBe(429);
  expect(mockRpc).not.toHaveBeenCalled();
  mockRpc.mockResolvedValue({data:[],error:null});
  for(let i=0;i<90;i++) expect((await GET(new Request('https://example.invalid/api/search/suggest'))).status).toBe(200);
  mockRpc.mockClear();
  expect((await GET(new Request('https://example.invalid/api/search/suggest'))).status).toBe(429);
  expect(mockRpc).not.toHaveBeenCalled();
});
test('query aliases and page are passed to the database as parameters',async()=>{
  const res=await POST(request({q:'e-commerce',page:2}));expect(res.status).toBe(200);
  expect(mockRpc).toHaveBeenCalledWith('search_relevance_v1',expect.objectContaining({query_text:'ecommerce',page_number:2,page_size:20,related_terms:expect.arrayContaining(['dropshipping'])}));
});
test('opened search videos receive the same seller verification status as the feed',async()=>{
  mockRpc.mockResolvedValue({data:{...EMPTY_SEARCH,items:[
    {id:'video-1',creator_id:'seller',creator:{username:'seller'},caption:'',content:null,media_url:'video.mp4',poster_url:null},
    {id:'video-2',creator_id:'newcomer',creator:{username:'newcomer'},caption:'',content:null,media_url:'video2.mp4',poster_url:null},
  ]},error:null});
  const inProfiles=jest.fn().mockResolvedValue({data:[
    {id:'seller',stripe_account_id:'acct_123',stripe_onboarding_complete:true},
    {id:'newcomer',stripe_account_id:null,stripe_onboarding_complete:false},
  ],error:null});
  const selectProfiles=jest.fn().mockReturnValue({in:inProfiles});
  mockFrom.mockReturnValue({select:selectProfiles});
  const res=await POST(request({q:'video'}));
  expect(res.status).toBe(200);
  expect(mockFrom).toHaveBeenCalledWith('profiles');
  expect(inProfiles).toHaveBeenCalledWith('id',['seller','newcomer']);
  expect((await res.json()).items).toEqual([
    expect.objectContaining({id:'video-1',creator_verified:true}),
    expect.objectContaining({id:'video-2',creator_verified:false}),
  ]);
});
test('database failure is not returned as an empty successful search',async()=>{
  const log=jest.spyOn(console,'error').mockImplementation(()=>{});
  mockRpc.mockResolvedValue({data:null,error:{message:'internal database details'}});
  const res=await POST(request({q:'ecom'}));expect(res.status).toBe(503);expect(JSON.stringify(await res.json())).not.toContain('internal database');log.mockRestore();
});
test('suggestions expose live topic and identity labels',async()=>{
  mockRpc.mockImplementation(async(name:string)=>({data:name==='search_topics_v1' ? [{label:'ecommerce'}] : {creators:[{username:'ecomcoach'}],offerings:[]},error:null}));
  const res=await GET(new Request('https://example.invalid/api/search/suggest?q=ecom'));
  expect(await res.json()).toMatchObject({suggestions:[{label:'ecomcoach',type:'creator'},{label:'ecommerce',type:'topic'}]});
});

test('full-name suggestions find the username without suggesting topic-only matches',async()=>{
  mockRpc.mockImplementation(async(name:string)=>({data:name==='search_topics_v1' ? [] : {creators:[
    {username:'storebuilder',full_name:'Luis Garcia'},
    {username:'lifestyle',full_name:'Another Person'},
  ],offerings:[]},error:null}));
  const res=await GET(new Request('https://example.invalid/api/search/suggest?q=Luis'));
  expect(await res.json()).toMatchObject({suggestions:[{label:'storebuilder',type:'creator'}]});
});
