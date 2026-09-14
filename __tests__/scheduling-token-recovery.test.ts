import { createMockClient, type MockClient } from './__mocks__/supabaseQueryMock';
let db: MockClient;
const api = jest.fn(), exchange = jest.fn();
jest.mock('@/lib/supabaseAdmin',()=>({get supabaseAdmin(){return db;}}));
jest.mock('@/lib/schedulingSecrets',()=>({openSchedulingSecret:(s:string)=>s,sealSchedulingSecret:(s:string)=>s}));
jest.mock('@/lib/schedulingConfig',()=>({schedulingConfig:()=>({}),schedulingOrigin:()=> 'https://test.invalid'}));
jest.mock('@/lib/schedulingProvider',()=>({
 ...jest.requireActual('@/lib/schedulingProvider'),
 schedulingApi:(...args:unknown[])=>api(...args),
 exchangeSchedulingToken:(...args:unknown[])=>exchange(...args),
}));
import { hydrateCalendlyEvent } from '@/lib/schedulingConnections';
import { SchedulingProviderError } from '@/lib/schedulingProvider';
let row: Record<string,any>;
beforeEach(()=>{
 api.mockReset(); exchange.mockReset();
 row={id:'connection',creator_id:'creator',provider:'calendly',status:'connected',account_id:'account',
 credentials_ciphertext:JSON.stringify({accessToken:'old',refreshToken:'refresh',expiresAt:Date.now()+3600000})};
 db=createMockClient(op=>{
  if(op.kind==='update') Object.assign(row,op.payload);
  return {data:{...row},error:null};
 });
 const from=db.from;
 db.from=table=>{
  const source=from(table),update=source.update;
  return {...source,upsert:source.insert,update:(values:unknown)=>{
   const chain=update(values);chain.gt=(key:string,value:unknown)=>chain.eq('__gt_'+key,value);return chain;
  }};
 };
 exchange.mockResolvedValue({accessToken:'fresh',refreshToken:'rotated',expiresAt:Date.now()+3600000});
});
const run=()=>hydrateCalendlyEvent('creator','https://api.calendly.com/scheduled_events/event');
test('a rejected unexpired token refreshes once and retries the owner-bound event read',async()=>{
 api.mockRejectedValueOnce(new SchedulingProviderError(401)).mockResolvedValueOnce({resource:{event_memberships:[{user:'account'}]}});
 await expect(run()).resolves.toBeDefined();
 expect(exchange).toHaveBeenCalledTimes(1);
 expect(api.mock.calls.map(args=>args[1])).toEqual(['old','fresh']);
 expect(JSON.parse(row.credentials_ciphertext).refreshToken).toBe('rotated');
 expect(row.status).toBe('connected');
});
test('rejected refreshed authorization requires reconnect and does not loop',async()=>{
 api.mockRejectedValue(new SchedulingProviderError(401));
 await expect(run()).rejects.toThrow();
 expect(exchange).toHaveBeenCalledTimes(1);expect(api).toHaveBeenCalledTimes(2);
 expect(row.status).toBe('reconnect_required');expect(row.lease_id).toBeNull();
});
test('transient provider failure does not rotate credentials or require reconnect',async()=>{
 api.mockRejectedValue(new SchedulingProviderError(503));
 await expect(run()).rejects.toThrow();
 expect(exchange).not.toHaveBeenCalled();expect(row.status).toBe('connected');
});
test('revoked refresh token requires reconnect without repeating the event request',async()=>{
 api.mockRejectedValue(new SchedulingProviderError(401));exchange.mockRejectedValue(new SchedulingProviderError(400));
 await expect(run()).rejects.toThrow();
 expect(row.status).toBe('reconnect_required');expect(api).toHaveBeenCalledTimes(1);
});
test('refresh success never bypasses scheduled-event ownership',async()=>{
 api.mockRejectedValueOnce(new SchedulingProviderError(401)).mockResolvedValueOnce({resource:{event_memberships:[{user:'someone-else'}]}});
 await expect(run()).rejects.toThrow('Scheduled event owner mismatch');
 expect(exchange).toHaveBeenCalledTimes(1);expect(row.status).toBe('connected');
});
