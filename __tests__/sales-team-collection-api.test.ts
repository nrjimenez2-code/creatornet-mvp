import {NextRequest} from "next/server";
import {TeamSalesError} from "@/lib/salesTeams/policy";
const owned=jest.fn(),compose=jest.fn(),read=jest.fn(),prepare=jest.fn(),confirm=jest.fn(),stop=jest.fn(),checkout=jest.fn();
jest.mock("@/lib/salesTeams/checkout",()=>({readBuyerTeamSale:(...a:unknown[])=>owned(...a),requireTeamCheckout:()=>checkout()}));
jest.mock("@/lib/salesTeams/context",()=>({createTeamPaymentContext:()=>compose()}));
jest.mock("@/lib/salesTeams/collection",()=>({readTeamCollection:(...a:unknown[])=>read(...a),teamCollectionView:(s:{view:unknown})=>s.view,prepareTeamCollection:(...a:unknown[])=>prepare(...a),confirmTeamCollection:(...a:unknown[])=>confirm(...a),stopTeamCollection:(...a:unknown[])=>stop(...a)}));
jest.mock("@/lib/supabaseClient",()=>({createServerSupabase:jest.fn()}));
import {GET,POST} from "@/app/api/sales-team/sales/[saleId]/payment/route";
const env={...process.env},sale="00000000-0000-4000-8000-000000000020",buyer="00000000-0000-4000-8000-000000000010",requestId="00000000-0000-4000-8000-000000000070";
const context={params:Promise.resolve({saleId:sale})},view={phase:"not_started"},composition={kind:"composition"};let admin:Record<string,unknown>;
const request=(body?:unknown,origin="https://fixture.vercel.app")=>new NextRequest(`https://fixture.vercel.app/api/sales-team/sales/${sale}/payment`,{method:body?"POST":"GET",headers:{origin,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
beforeEach(()=>{
 jest.clearAllMocks();for(const key of ["CREATOR_SALES_TEAM_SCHEMA_READY","CREATOR_TEAM_SALE_AGREEMENTS_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_LEDGER_SCHEMA_READY","CREATOR_TEAM_PAYMENT_SCHEMA_READY"])process.env[key]="true";
 for(const key of ["CREATOR_SALES_TEAM_READY","CREATOR_TEAM_SALES_CHECKOUT_READY","CREATOR_TEAM_PAYMENT_COLLECTION_READY"])delete process.env[key];
 admin={kind:"scoped-admin"};owned.mockResolvedValue({admin,user:{id:buyer},sale:{status:"accepted"}});read.mockResolvedValue({view});compose.mockReturnValue(composition);prepare.mockResolvedValue({view});confirm.mockResolvedValue(view);stop.mockResolvedValue(view);
});afterEach(()=>{process.env={...env};});
const enabled=()=>{for(const key of ["CREATOR_SALES_TEAM_READY","CREATOR_TEAM_SALES_CHECKOUT_READY","CREATOR_TEAM_PAYMENT_COLLECTION_READY","CREATOR_TEAM_RECEIPT_SCHEMA_READY","CREATOR_TEAM_RECEIPT_RECORDING_READY","CREATOR_TEAM_FULFILLMENT_SCHEMA_READY","CREATOR_TEAM_FULFILLMENT_READY","CREATOR_TEAM_EVENT_SCHEMA_READY","CREATOR_TEAM_EVENT_RECONCILIATION_READY","CREATOR_TEAM_FINANCIAL_SCHEMA_READY","CREATOR_TEAM_FINANCIAL_RECONCILIATION_READY"])process.env[key]="true";};
test("status is buyer-owned and available while new collection is held",async()=>{
 const response=await GET(request(),context);expect(response.status).toBe(200);expect(await response.json()).toEqual({payment:view,collectionEnabled:false});expect(response.headers.get("cache-control")).toBe("private, no-store");
 expect(read).toHaveBeenCalledWith({admin},sale,buyer);expect(compose).not.toHaveBeenCalled();
});
test.each(["prepare","confirm","reconfirm"])("%s cannot create provider activity when the independent source gate is off",async action=>{
 expect((await POST(request({action,...(action!=="prepare"?{request_id:requestId}:{}),...(action==="confirm"?{confirmation_token:"ctoken_original"}:{})}),context)).status).toBe(409);expect(compose).not.toHaveBeenCalled();
});
test("schema and ownership failures happen before provider composition",async()=>{
 delete process.env.CREATOR_TEAM_PAYMENT_SCHEMA_READY;expect((await GET(request(),context)).status).toBe(404);expect(owned).not.toHaveBeenCalled();
 process.env.CREATOR_TEAM_PAYMENT_SCHEMA_READY="true";owned.mockRejectedValue(new TeamSalesError("UNAUTHORIZED","Sign in.",401));expect((await POST(request({action:"refresh"}),context)).status).toBe(401);expect(compose).not.toHaveBeenCalled();
});
test.each(["amount","buyer_id","customer_id","payment_intent_id","return_url","account_id"])("caller %s cannot replace a saved payment parameter",async key=>{
 enabled();expect((await POST(request({action:"confirm",request_id:requestId,confirmation_token:"ctoken_original",[key]:"forged"}),context)).status).toBe(400);expect(compose).not.toHaveBeenCalled();
});
test("new preparation uses only saved sale and authenticated buyer identities",async()=>{
 enabled();expect((await POST(request({action:"prepare"}),context)).status).toBe(200);expect(prepare).toHaveBeenCalledWith(composition,sale,buyer,true);
 expect((await POST(request({action:"confirm",request_id:requestId,confirmation_token:"ctoken_original"}),context)).status).toBe(200);expect(confirm).toHaveBeenCalledWith(composition,sale,buyer,{requestId,kind:"token",tokenId:"ctoken_original"});
});
test("fresh collection requires independent financial reconciliation readiness",async()=>{
 enabled();delete process.env.CREATOR_TEAM_FINANCIAL_RECONCILIATION_READY;
 expect((await POST(request({action:"prepare"}),context)).status).toBe(409);expect(compose).not.toHaveBeenCalled();
});
test("Stop and refresh retain original recovery with new activity disabled",async()=>{
 expect((await POST(request({action:"stop"}),context)).status).toBe(200);expect(stop).toHaveBeenCalledWith(composition,sale,buyer);
 expect((await POST(request({action:"refresh"}),context)).status).toBe(200);expect(prepare).toHaveBeenCalledWith(composition,sale,buyer,false);expect(checkout).not.toHaveBeenCalled();
});
test("saved original confirmations can reconcile with new collection disabled",async()=>{
 const query={select:()=>query,eq:()=>query,maybeSingle:async()=>({data:{kind:"token",token_id:"ctoken_original"},error:null})};
 admin.from=()=>query;read.mockResolvedValue({obligation:{id:sale}});
 expect((await POST(request({action:"resume",request_id:requestId,confirmation_token:"ctoken_original"}),context)).status).toBe(200);
 expect(confirm).toHaveBeenCalledWith(composition,sale,buyer,{requestId,kind:"token",tokenId:"ctoken_original",recoveryOnly:true});expect(checkout).not.toHaveBeenCalled();
});
test("an unadmitted browser token cannot become fresh activity during held recovery",async()=>{
 const query={select:()=>query,eq:()=>query,maybeSingle:async()=>({data:null,error:null})};admin.from=()=>query;read.mockResolvedValue({obligation:{id:sale}});
 expect((await POST(request({action:"resume",request_id:requestId,confirmation_token:"ctoken_original"}),context)).status).toBe(409);expect(confirm).not.toHaveBeenCalled();
 enabled();expect((await POST(request({action:"resume",request_id:requestId,confirmation_token:"ctoken_original"}),context)).status).toBe(200);
 expect(confirm).toHaveBeenCalledWith(composition,sale,buyer,{requestId,kind:"token",tokenId:"ctoken_original"});
});
test("foreign origins and unaccepted reviews cannot reach provider access",async()=>{
 expect((await POST(request({action:"stop"},"https://foreign.test"),context)).status).toBe(403);expect(owned).not.toHaveBeenCalled();
 owned.mockResolvedValue({admin,user:{id:buyer},sale:{status:"review"}});expect((await GET(request(),context)).status).toBe(409);expect(compose).not.toHaveBeenCalled();
});
