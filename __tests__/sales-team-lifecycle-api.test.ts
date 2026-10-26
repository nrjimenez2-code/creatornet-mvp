import {NextRequest} from "next/server";
const owned=jest.fn(),compose=jest.fn(),readQuote=jest.fn(),exit=jest.fn(),payoff=jest.fn(),overview=jest.fn(),stop=jest.fn();
jest.mock("@/lib/salesTeams/checkout",()=>({readBuyerTeamSale:(...a:unknown[])=>owned(...a)}));
jest.mock("@/lib/salesTeams/context",()=>({createTeamPaymentContext:()=>compose()}));
jest.mock("@/lib/salesTeams/collection",()=>({readTeamExitQuote:(...a:unknown[])=>readQuote(...a),requestTeamExit:(...a:unknown[])=>exit(...a),prepareTeamPayoff:(...a:unknown[])=>payoff(...a),readTeamCollectionOverview:(...a:unknown[])=>overview(...a),stopTeamCollection:(...a:unknown[])=>stop(...a),teamCollectionView:(s:{view:unknown})=>s.view}));
jest.mock("@/lib/supabaseClient",()=>({createServerSupabase:jest.fn()}));
import {GET,POST} from "@/app/api/sales-team/sales/[saleId]/lifecycle/route";
const env={...process.env},sale="00000000-0000-4000-8000-000000000020",buyer="00000000-0000-4000-8000-000000000010",requestId="00000000-0000-4000-8000-000000000150",obligation="00000000-0000-4000-8000-000000000092";
const context={params:Promise.resolve({saleId:sale})},admin={kind:"admin"},composition={admin,kind:"composition"},q={minimumMonths:3,coveredPeriods:1,fingerprint:"a".repeat(64)},view={phase:"paid"};
const request=(body?:unknown,origin="https://fixture.vercel.app")=>new NextRequest(`https://fixture.vercel.app/api/sales-team/sales/${sale}/lifecycle`,{method:body?"POST":"GET",headers:{origin,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
beforeEach(()=>{
 jest.clearAllMocks();for(const key of ["CREATOR_SALES_TEAM_SCHEMA_READY","CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY","CREATOR_TEAM_PAYMENT_SCHEMA_READY","CREATOR_TEAM_LATER_COLLECTION_SCHEMA_READY","CREATOR_TEAM_PAYMENT_LIFECYCLE_SCHEMA_READY"])process.env[key]="true";
 for(const key of ["CREATOR_SALES_TEAM_READY","CREATOR_TEAM_SALES_CHECKOUT_READY","CREATOR_TEAM_PAYOFF_COLLECTION_READY","CREATOR_TEAM_PAYMENT_COLLECTION_READY"])delete process.env[key];
 owned.mockResolvedValue({admin,user:{id:buyer},sale:{status:"accepted"}});compose.mockReturnValue(composition);readQuote.mockResolvedValue(q);exit.mockResolvedValue(q);overview.mockResolvedValue({payment:{view,receipt:{id:"paid-first"},obligation:{id:sale,period_number:1}}});stop.mockResolvedValue({phase:"later_stopped"});payoff.mockResolvedValue({view:{phase:"needs_method",obligationId:obligation}});
});afterEach(()=>{process.env={...env};});
const enablePayoff=()=>{for(const key of ["CREATOR_TEAM_PAYOFF_COLLECTION_READY","CREATOR_TEAM_PAYMENT_COLLECTION_READY","CREATOR_TEAM_RECEIPT_SCHEMA_READY","CREATOR_TEAM_RECEIPT_RECORDING_READY","CREATOR_TEAM_FULFILLMENT_SCHEMA_READY","CREATOR_TEAM_FULFILLMENT_READY","CREATOR_TEAM_EVENT_SCHEMA_READY","CREATOR_TEAM_EVENT_RECONCILIATION_READY","CREATOR_TEAM_FINANCIAL_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_RECONCILIATION_READY"])process.env[key]="true";};
test("quote is read-only and buyer-owned while new payoff collection is held",async()=>{
 const response=await GET(request(),context);expect(await response.json()).toEqual({quote:q,payoffCollectionEnabled:false});expect(response.headers.get("cache-control")).toBe("private, no-store");expect(readQuote).toHaveBeenCalledWith({admin},sale,buyer);expect(compose).not.toHaveBeenCalled();
});
test.each(["stop_renewal","revoke_debits"])("%s remains available with every new-money source gate off",async action=>{
 expect((await POST(request({action,request_id:requestId,accepted:true}),context)).status).toBe(200);expect(exit).toHaveBeenCalledWith({admin},sale,buyer,{requestId,kind:action,accepted:true});expect(compose).not.toHaveBeenCalled();
});
test("revocation saves before it composes cancellation of the exact pending original",async()=>{
 overview.mockResolvedValue({payment:{view,receipt:null,obligation:{id:obligation,period_number:2}}});expect((await POST(request({action:"revoke_debits",request_id:requestId,accepted:true}),context)).status).toBe(200);
 expect(stop).toHaveBeenCalledWith(composition,sale,buyer,obligation);expect(exit.mock.invocationCallOrder[0]).toBeLessThan(compose.mock.invocationCallOrder[0]);
});
test("minimum renewal-stop does not cancel a still-due minimum installment",async()=>{
 overview.mockResolvedValue({payment:{view,receipt:null,obligation:{id:obligation,period_number:2}}});expect((await POST(request({action:"stop_renewal",request_id:requestId,accepted:true}),context)).status).toBe(200);expect(stop).not.toHaveBeenCalled();expect(compose).not.toHaveBeenCalled();
});
test("a separately accepted payoff needs independent readiness before provider composition",async()=>{
 const body={action:"prepare_payoff",request_id:requestId,accepted:true,fingerprint:q.fingerprint};expect((await POST(request(body),context)).status).toBe(409);expect(compose).not.toHaveBeenCalled();enablePayoff();expect((await POST(request(body),context)).status).toBe(200);expect(payoff).toHaveBeenCalledWith(composition,sale,buyer,{requestId,fingerprint:q.fingerprint,accepted:true});
});
test.each(["amount_cents","remaining_months","period_end","buyer_id","customer_id"])("the buyer cannot supply payoff %s",async field=>{
 enablePayoff();expect((await POST(request({action:"prepare_payoff",request_id:requestId,accepted:true,fingerprint:q.fingerprint,[field]:1}),context)).status).toBe(400);expect(compose).not.toHaveBeenCalled();
});
test("schema, origin, consent and accepted-sale checks precede provider access",async()=>{
 delete process.env.CREATOR_TEAM_PAYMENT_LIFECYCLE_SCHEMA_READY;expect((await GET(request(),context)).status).toBe(404);expect(owned).not.toHaveBeenCalled();process.env.CREATOR_TEAM_PAYMENT_LIFECYCLE_SCHEMA_READY="true";
 expect((await POST(request({action:"revoke_debits",request_id:requestId,accepted:true},"https://foreign.test"),context)).status).toBe(403);expect((await POST(request({action:"revoke_debits",request_id:requestId,accepted:false}),context)).status).toBe(400);owned.mockResolvedValue({admin,user:{id:buyer},sale:{status:"review"}});expect((await GET(request(),context)).status).toBe(409);expect(compose).not.toHaveBeenCalled();
});
