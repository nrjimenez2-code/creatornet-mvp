import { NextRequest } from 'next/server';
import { createMockClient, type MockClient } from './__mocks__/supabaseQueryMock';
import { _resetRateLimits } from '@/lib/rateLimit';
let mockDb:MockClient;
let mockUser:{id:string}|null;
const mockInterest=jest.fn();
const mockBump=jest.fn();
jest.mock('@/lib/supabaseServer',()=>({createServerClient:()=>({auth:{getUser:async()=>({data:{user:mockUser},error:null})}})}));
jest.mock('@supabase/supabase-js',()=>({createClient:()=>mockDb}));
jest.mock('@/lib/updateInterestScore',()=>({updateInterestScore:(...args:unknown[])=>mockInterest(...args)}));
jest.mock('@/lib/postCounters',()=>({bumpPostLikes:(...args:unknown[])=>mockBump(...args)}));
import { PUT,POST } from '@/app/api/posts/[postId]/like/route';
const flag=process.env.POST_LIKE_RPC_V1;
const call=(method:'PUT'|'POST'='PUT')=>(method==='PUT'?PUT:POST)(new NextRequest('https://example.invalid/api/posts/post/like',{method,body:JSON.stringify({user_id:'attacker'})}),{params:Promise.resolve({postId:'post'})});
beforeEach(()=>{jest.clearAllMocks();_resetRateLimits();process.env.POST_LIKE_RPC_V1='true';mockUser={id:'verified-viewer'};});
afterEach(()=>{if(flag===undefined)delete process.env.POST_LIKE_RPC_V1;else process.env.POST_LIKE_RPC_V1=flag;});
test.each(['PUT','POST'] as const)('%s uses verified actor, one mutation RPC and existing interest helper',async method=>{
  mockDb=createMockClient(()=>({data:{liked:true,likes_count:1,inserted:true,category:' Content Creation '},error:null}));
  expect(await (await call(method)).json()).toEqual({success:true,liked:true,likes_count:1});
  expect(mockDb.ops).toHaveLength(1);
  expect(mockDb.ops[0]).toMatchObject({kind:'rpc',table:'update_post_like_v1',payload:{p_user_id:'verified-viewer',p_post_id:'post',p_like_only:method==='PUT'}});
  expect(mockInterest).toHaveBeenCalledWith('verified-viewer',' Content Creation ',5);
  expect(mockBump).not.toHaveBeenCalled();
});
test.each([true,false])('no extra score for unchanged or removed like (%s)',async liked=>{
  mockDb=createMockClient(()=>({data:{liked,likes_count:0,inserted:false,category:null},error:null}));
  expect((await call()).status).toBe(200);expect(mockInterest).not.toHaveBeenCalled();
});
test('signed-out actor cannot reach the RPC',async()=>{
  mockUser=null;mockDb=createMockClient();expect((await call()).status).toBe(401);expect(mockDb.ops).toHaveLength(0);
});
test.each([{code:'PGRST202',message:'missing function'},{code:'57014',message:'timeout'}])('RPC error never replays a potentially committed mutation (%s)',async error=>{
  jest.spyOn(console,'error').mockImplementation(()=>{});
  try {mockDb=createMockClient(()=>({data:null,error}));expect((await call()).status).toBe(500);expect(mockDb.ops).toHaveLength(1);expect(mockInterest).not.toHaveBeenCalled();expect(mockBump).not.toHaveBeenCalled();}
  finally{jest.restoreAllMocks();}
});
test('flag off retains existing route behavior',async()=>{
  delete process.env.POST_LIKE_RPC_V1;
  mockDb=createMockClient(op=>({data:op.table==='likes'?{id:'existing'}:{likes_count:9},error:null}));
  expect(await (await call()).json()).toEqual({success:true,liked:true,likes_count:9});
  expect(mockDb.ops.every(op=>op.kind!=='rpc')).toBe(true);
});
test.each([null,{liked:true,inserted:true,likes_count:-1,category:null},{liked:true,inserted:true,likes_count:1,category:{}}])('invalid RPC result fails closed without interest or fallback writes',async data=>{
  jest.spyOn(console,'error').mockImplementation(()=>{});
  try {mockDb=createMockClient(()=>({data,error:null}));expect((await call()).status).toBe(500);expect(mockDb.ops).toHaveLength(1);expect(mockInterest).not.toHaveBeenCalled();expect(mockBump).not.toHaveBeenCalled();}
  finally{jest.restoreAllMocks();}
});
