import {createMockClient,type MockClient} from './__mocks__/supabaseQueryMock';
let db:MockClient;
jest.mock('@/lib/supabaseAdmin',()=>({get supabaseAdmin(){return db;}}));
jest.mock('@/lib/supabaseServer',()=>({createServerClient:()=>({})}));
import {loadDiscoverEventContext} from '@/lib/discoverEventContext';
beforeEach(()=>{process.env.DISCOVER_EVENT_CONTEXT_ENABLED='true';});
afterEach(()=>{delete process.env.DISCOVER_EVENT_CONTEXT_ENABLED;});
test('uses the supplied verified actor and returns metadata without extra table reads',async()=>{
 db=createMockClient(op=>{
  expect(op.table).toBe('discover_event_context_v1');
  expect(op.payload).toEqual({p_session:'session',p_actor:'user:viewer',p_post:'post'});
  return {data:{post:{id:'post',creator_id:'creator'},audience:'photography',primaryProducts:[],legacyProducts:[],offerings:[]},error:null};
 });
 expect(await loadDiscoverEventContext('session','user:viewer','post')).toEqual({
  post:{id:'post',creator_id:'creator'},audience:'photography',offers:{primaryProducts:[],legacyProducts:[],offerings:[]},
 });
});
test('unavailable context is denied, RPC errors and malformed metadata fail closed',async()=>{
 db=createMockClient(()=>({data:null,error:null}));
 expect(await loadDiscoverEventContext('s','a','p')).toBeNull();
 db=createMockClient(()=>({data:null,error:new Error('unavailable')}));
 await expect(loadDiscoverEventContext('s','a','p')).rejects.toThrow('unavailable');
 db=createMockClient(()=>({data:{post:{id:'other',creator_id:'creator'}},error:null}));
 await expect(loadDiscoverEventContext('s','a','p')).rejects.toThrow('Invalid event context');
});

test('combined watch RPC returns only server-calculated time and denies malformed IDs',async()=>{
 db=createMockClient(op=>{
  expect(op.table).toBe('discover_watch_context_v1');
  expect(op.payload).toEqual({p_session:'session',p_actor:'user:viewer',p_post:'post',p_claimed:50});
  return {data:{post:{id:'post',creator_id:'creator'},audience:'general',primaryProducts:[],legacyProducts:[],offerings:[],watched:5},error:null};
 });
 expect((await loadDiscoverEventContext('session','user:viewer','post',50))?.watched).toBe(5);
 db=createMockClient(()=>({data:null,error:{code:'22P02'}}));
 expect(await loadDiscoverEventContext('bad','user:viewer','post',5)).toBeNull();
});
