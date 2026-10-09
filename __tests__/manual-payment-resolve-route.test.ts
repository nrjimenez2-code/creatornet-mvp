import {NextRequest} from "next/server";
import {createMockClient} from "./__mocks__/supabaseQueryMock";
const mockAuth=jest.fn(),mockObserve=jest.fn(),mockFresh=jest.fn();let mockProtocol:any,mockRequest:any;
const mockDb=createMockClient(op=>({data:op.table==="server_payment_protocols_v1"?mockProtocol:mockRequest,error:null}));
jest.mock("@supabase/supabase-js",()=>({createClient:()=>mockDb}));
jest.mock("../lib/supabaseConnectAuth",()=>({getAuthenticatedUser:()=>mockAuth()}));
jest.mock("../lib/installments/contextServer",()=>({exactContextServerConfig:()=>({approvedContext:context,configuredSupabaseUrl:"https://fixture.invalid",supabaseServiceKey:"fixture"})}));
jest.mock("../lib/installments/contextRuntime",()=>({createExactContextRuntime:()=>({observeContext:mockObserve}),assertFreshExactRuntimeContextObservation:(v:unknown)=>mockFresh(v)}));
import {GET} from "../app/api/checkout/manual/resolve/route";
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const context={mode:"test",siteOrigin:"https://fixture.invalid"};
const request=(query="attempt_id="+id(1))=>GET(new NextRequest("https://fixture.invalid/api/checkout/manual/resolve?"+query));
let env:NodeJS.ProcessEnv;
beforeEach(()=>{env={...process.env};jest.resetAllMocks();mockDb.ops.length=0;process.env.CREATOR_SERVER_PAYMENT_PROTOCOL_SCHEMA_READY="true";
  mockAuth.mockResolvedValue({id:id(2)});mockObserve.mockResolvedValue({});mockProtocol={kind:"full",attempt_id:id(1)};mockRequest={request_id:id(3)};});
afterEach(()=>{process.env=env;});
test.each(["full","first_installment"])("%s resolves only the authenticated original under current context",async kind=>{
  mockProtocol={kind,attempt_id:id(1),reservation_id:id(4)};
  const r=await request();expect(r.status).toBe(200);expect(await r.json()).toEqual({requestId:id(3),mode:kind==="full"?"full":"installments"});
  expect(mockDb.ops[0].filters).toEqual({attempt_id:id(1),buyer_id:id(2),context});
  expect(mockDb.ops[1].filters).toEqual({attempt_id:id(1),buyer_id:id(2),context,...(kind==="first_installment"?{id:id(4)}:{})});
  expect(r.headers.get("cache-control")).toBe("private, no-store");
});
test.each(["signed out","disabled","foreign attempt","stale context","invalid request"])("%s does not produce a recovery identity",async issue=>{
  if(issue==="signed out")mockAuth.mockResolvedValue(null);if(issue==="disabled")process.env.CREATOR_SERVER_PAYMENT_PROTOCOL_SCHEMA_READY="false";
  if(issue==="foreign attempt")mockProtocol=null;if(issue==="stale context")mockFresh.mockImplementation(()=>{throw Error();});if(issue==="invalid request")mockRequest={request_id:"bad"};
  expect((await request()).status).toBeGreaterThanOrEqual(400);
});
test.each(["attempt_id=bad","attempt_id="+id(1)+"&buyer_id="+id(2),"attempt_id="+id(1)+"&attempt_id="+id(1)])("malformed query %s never reads payment data",async query=>{
  expect((await request(query)).status).toBe(400);expect(mockDb.ops).toHaveLength(0);
});
