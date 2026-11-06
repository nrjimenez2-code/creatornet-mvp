import { createHmac } from 'node:crypto';
const mockRpc=jest.fn(),mockAbort=jest.fn();
jest.mock('../lib/supabaseAdmin',()=>({supabaseAdmin:{rpc:(...args:unknown[])=>{mockRpc(...args);return {abortSignal:mockAbort};}}}));
import { hasLegacyPublicUploadReservation } from '../lib/legacyPublicUpload';
const key='videos/a1111111-1111-4111-8111-111111111111/launch_b2222222-2222-4222-8222-222222222222.mp4';
const input={ownerId:'a1111111-1111-4111-8111-111111111111',operationId:'b2222222-2222-4222-8222-222222222222',folder:'videos' as const,extension:'mp4',size:10,contentType:'video/mp4',key};
const synthetic='synthetic-legacy-lookup-hmac-key-for-local-tests';
beforeEach(()=>{jest.clearAllMocks();process.env.ABUSE_HMAC_KEY=synthetic;mockAbort.mockResolvedValue({data:{resource:key},error:null});});
afterEach(()=>{delete process.env.ABUSE_HMAC_KEY;});
test('pure lookup preserves the exact historical HMAC domains and contract ordering',async()=>{
  const hash=(domain:string,value:string)=>createHmac('sha256',synthetic).update('CreatorNetAbuse:v1:'+domain+':'+value).digest('hex');
  expect(await hasLegacyPublicUploadReservation(input)).toBe(true);
  expect(mockRpc).toHaveBeenCalledTimes(1);expect(mockRpc).toHaveBeenCalledWith('find_legacy_public_upload_reservation_v1',{
    p_actor:hash('actor','user:'+input.ownerId),p_operation:hash('operation','public:'+input.ownerId+':'+input.operationId),
    p_contract:hash('contract',JSON.stringify({folder:'videos',ext:'mp4',size:10,mime:'video/mp4'})),p_resource:key,
  });
});
test.each([null,{resource:'other'}])('missing/wrong reservation %p remains unresolved',async data=>{
  mockAbort.mockResolvedValue({data,error:null});expect(await hasLegacyPublicUploadReservation(input)).toBe(false);
});
test('unavailable lookup fails closed without an admission fallback',async()=>{
  mockAbort.mockResolvedValue({data:null,error:{message:'missing function'}});await expect(hasLegacyPublicUploadReservation(input)).rejects.toThrow('legacy_upload_reservation_unavailable');expect(mockRpc).toHaveBeenCalledTimes(1);
});
