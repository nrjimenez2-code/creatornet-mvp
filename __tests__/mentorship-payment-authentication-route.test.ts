import {NextRequest} from "next/server";
const mockAuth=jest.fn(),mockConfig=jest.fn(),mockCapability=jest.fn();
jest.mock("@/lib/supabaseConnectAuth",()=>({getAuthenticatedUser:(...a:unknown[])=>mockAuth(...a)}));
jest.mock("@/lib/installments/contextServer",()=>({exactContextServerConfig:()=>mockConfig()}));
jest.mock("@/lib/mentorshipServerPayment",()=>({authenticateBuyerMentorshipServerPayment:(...a:unknown[])=>mockCapability(...a)}));
import {POST} from "@/app/api/installments/reservations/[requestId]/payment-authentication/route";
const requestId="10000000-0000-4000-8000-000000000001",buyerId="10000000-0000-4000-8000-000000000002",
  operationId="10000000-0000-4000-8000-000000000003",origin="https://example.invalid";
const gates=["CREATOR_MENTORSHIP_INSTALLMENT_RESERVATIONS_SCHEMA_READY","CREATOR_SERVER_PAYMENT_INTENT_SCHEMA_READY",
  "CREATOR_SERVER_PAYMENT_CONFIRMATION_SCHEMA_READY","CREATOR_SERVER_PAYMENT_CONFIRMATION_READY",
  "CREATOR_SERVER_PAYMENT_AUTHENTICATION_SCHEMA_READY","CREATOR_SERVER_PAYMENT_AUTHENTICATION_READY",
  "CREATOR_SERVER_PAYMENT_AUTHENTICATION_ACTIONS_READY"];
const previous={...process.env};
beforeEach(()=>{
  jest.resetAllMocks();for(const gate of gates)process.env[gate]="true";
  mockAuth.mockResolvedValue({id:buyerId});mockConfig.mockReturnValue({approvedContext:{siteOrigin:origin}});
  mockCapability.mockResolvedValue({status:"authentication_required",operationId,paymentIntentId:"pi_owned",clientSecret:"pi_owned_secret_synthetic",
    privateProviderData:"must not be projected"});
});
afterAll(()=>{process.env=previous;});
const call=(options:{id?:string;body?:string;origin?:string;query?:string;contentType?:string}={})=>POST(
  new NextRequest(`${origin}/api/installments/reservations/${options.id??requestId}/payment-authentication${options.query??""}`,{
    method:"POST",headers:{origin:options.origin??origin,"content-type":options.contentType??"application/json"},
    body:options.body??JSON.stringify({operationId})}),{params:Promise.resolve({requestId:options.id??requestId})});
test("only authenticated identity and exact saved request/operation reach the capability, with private no-store projection",async()=>{
  const response=await call();expect(response.status).toBe(200);
  expect(mockCapability).toHaveBeenCalledWith({buyerId,requestId,operationId});
  expect(await response.json()).toEqual({status:"authentication_required",operationId,paymentIntentId:"pi_owned",clientSecret:"pi_owned_secret_synthetic"});
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie, Authorization");expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});
test.each(gates)("disabled %s prevents authentication/provider work",async gate=>{
  process.env[gate]="false";expect((await call()).status).toBe(409);
  expect(mockAuth).not.toHaveBeenCalled();expect(mockCapability).not.toHaveBeenCalled();
});
test("unauthenticated caller gets no provider or configuration read",async()=>{
  mockAuth.mockResolvedValue(null);expect((await call()).status).toBe(401);
  expect(mockConfig).not.toHaveBeenCalled();expect(mockCapability).not.toHaveBeenCalled();
});
test.each(["https://foreign.invalid",""])("origin %s cannot receive capability",async requestOrigin=>{
  expect((await call({origin:requestOrigin})).status).toBe(403);expect(mockCapability).not.toHaveBeenCalled();
});
test.each([{id:"bad"},{body:"null"},{body:"[]"},{body:"{"},{body:JSON.stringify({operationId,buyerId})},
  {body:JSON.stringify({operationId,amount:1})},{body:JSON.stringify({operationId:"not-a-uuid"})},{body:" ".repeat(1025)},
  {query:"?operationId=other"},{contentType:"text/plain"}])("invalid request %j cannot reach capability",async options=>{
  expect((await call(options)).status).toBe(400);expect(mockCapability).not.toHaveBeenCalled();
});
test.each(["foreign-owner rejection","stopped","other phase","not enabled"])("%s returns a generic private response",async issue=>{
  if(issue==="other phase")mockCapability.mockResolvedValue({status:"authentication_required",operationId:requestId,clientSecret:"private"});
  else if(issue==="not enabled")mockCapability.mockResolvedValue({status:"not_enabled"});
  else mockCapability.mockRejectedValue(Error("private provider data"));
  const response=await call();expect(response.status).toBe(409);expect(JSON.stringify(await response.json())).not.toMatch(/private|secret/);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
