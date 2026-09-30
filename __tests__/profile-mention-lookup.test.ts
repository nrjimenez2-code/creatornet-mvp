import { resolveBioMentions, suggestMentionAccounts } from '@/lib/profileMentionsServer';
import { GET } from '@/app/api/profile/mention-suggestions/route';
import { _resetRateLimits } from '@/lib/rateLimit';
const mockLimit = jest.fn();
const mockSelect = jest.fn();
const mockIs = jest.fn();
const mockOr = jest.fn();
const mockOrder = jest.fn();
const mockQuery = {select:mockSelect,is:mockIs,or:mockOr,order:mockOrder,limit:mockLimit};
jest.mock('@/lib/supabaseAdmin',()=>({supabaseAdmin:{from:()=>mockQuery}}));
const account = {id:'1',username:'no.ah_1',full_name:'Noah',avatar_url:null};
beforeEach(()=>{
  _resetRateLimits(); jest.clearAllMocks();
  for (const fn of [mockSelect,mockIs,mockOr,mockOrder]) fn.mockReturnValue(mockQuery);
  mockLimit.mockResolvedValue({data:[account],error:null});
});
test('distinct mention lookup is one bounded query, escapes literal underscores, and exposes only public identities',async()=>{
  expect(await resolveBioMentions('@NO.AH_1 @no.ah_1 email@no.ah_1 @unknown')).toEqual({accounts:[account],ambiguousNames:[]});
  expect(mockLimit).toHaveBeenCalledTimes(1);expect(mockLimit).toHaveBeenCalledWith(801);
  expect(mockSelect).toHaveBeenCalledWith('id, username, full_name, avatar_url');
  expect(mockIs).toHaveBeenCalledWith('banned_at',null);
  expect(mockOr).toHaveBeenCalledWith('username.ilike.no.ah\\_1,username.ilike.unknown');
});
test('ambiguous names stay unlinked; failures and thrown requests leave bio usable',async()=>{
  mockLimit.mockResolvedValue({data:[account,{...account,id:'2',username:'NO.AH_1'}],error:null});
  expect(await resolveBioMentions('@no.ah_1')).toEqual({accounts:[],ambiguousNames:['no.ah_1']});
  mockLimit.mockResolvedValue({data:null,error:{message:'offline'}});expect(await resolveBioMentions('@no.ah_1')).toEqual({accounts:[],ambiguousNames:[]});
  mockLimit.mockRejectedValue(new Error('offline'));expect(await resolveBioMentions('@no.ah_1')).toEqual({accounts:[],ambiguousNames:[]});
});
test('no mentions skip database and truncated results fail closed',async()=>{
  expect(await resolveBioMentions('email@no.ah_1')).toEqual({accounts:[],ambiguousNames:[]});expect(mockLimit).not.toHaveBeenCalled();
  mockLimit.mockResolvedValue({data:Array(801).fill(account),error:null});expect(await resolveBioMentions('@no.ah_1')).toEqual({accounts:[],ambiguousNames:[]});
});
test('retains exact ambiguity even when stripping a sentence-ending period finds a valid shorter name',async()=>{
  mockLimit.mockResolvedValue({data:[{...account,username:'coach'},{...account,id:'2',username:'coach.'},{...account,id:'3',username:'COACH.'}],error:null});
  expect(await resolveBioMentions('@coach. @coach')).toEqual({accounts:[{...account,username:'coach'}],ambiguousNames:['coach.']});
  expect(mockLimit).toHaveBeenCalledTimes(1);
});
test('account suggestions preserve punctuation and query identities rather than topic/offer search',async()=>{
  expect(await suggestMentionAccounts('no.ah_')).toEqual([account]);
  expect(mockOr).toHaveBeenNthCalledWith(1,'username.ilike.no.ah\\_%,full_name.ilike.no.ah\\_%');
  expect(mockLimit).toHaveBeenNthCalledWith(1,5);
});
test('invalid inputs and rate limits stop queries; failures return a fixed error',async()=>{
  const request=(q:string)=>new Request('https://example.test/api/profile/mention-suggestions?q='+encodeURIComponent(q));
  expect((await GET(request('no,ah'))).status).toBe(400);expect(mockLimit).not.toHaveBeenCalled();
  for(let i=0;i<89;i++) expect((await GET(request('no'))).status).toBe(200);
  mockLimit.mockClear();expect((await GET(request('no'))).status).toBe(429);expect(mockLimit).not.toHaveBeenCalled();
  _resetRateLimits();mockLimit.mockResolvedValue({data:null,error:{message:'private details'}});
  const res=await GET(request('no'));expect(res.status).toBe(503);expect(await res.json()).toEqual({error:'Suggestions unavailable.'});
});
