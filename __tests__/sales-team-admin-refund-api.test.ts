import {NextRequest} from "next/server";
const auth=jest.fn(),schema=jest.fn(),enabled=jest.fn(),compose=jest.fn(),preview=jest.fn(),reserve=jest.fn(),processOriginal=jest.fn(),cancel=jest.fn(),read=jest.fn();
jest.mock("@/lib/admin/server",()=>({requireAdmin:(...a:unknown[])=>auth(...a),adminAuthErrorResponse:()=>new Response("{}",{status:403})}));
jest.mock("@/lib/salesTeams/policy",()=>({teamRefundDispatchSchemaReady:()=>schema(),teamRefundDispatchReady:()=>enabled()}));
jest.mock("@/lib/salesTeams/context",()=>({createTeamPaymentContext:()=>compose()}));
jest.mock("@/lib/salesTeams/adminRefunds",()=>({previewTeamAdminRefund:(...a:unknown[])=>preview(...a),reserveTeamAdminRefund:(...a:unknown[])=>reserve(...a),processTeamAdminRefund:(...a:unknown[])=>processOriginal(...a),cancelUnsentTeamRefund:(...a:unknown[])=>cancel(...a),readTeamAdminRefund:(...a:unknown[])=>read(...a),teamAdminRefundView:()=>({saved:true})}));
import {GET,POST} from "@/app/api/admin/sales-team/refunds/route";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`,c={original:true};
const body={action:"create",receiptId:id(1),requestId:id(2),expectedRevision:7,amountCents:1000,responsibility:"creator",reasonCode:"creator_discretionary",confirm:true};
const request=(value:unknown=body,origin="https://fixture.invalid")=>new NextRequest("https://fixture.invalid/api/admin/sales-team/refunds",{method:"POST",headers:{host:"fixture.invalid",origin,"content-type":"application/json"},body:JSON.stringify(value)});
beforeEach(()=>{jest.clearAllMocks();auth.mockResolvedValue({user:{id:id(29)},admin:{}});schema.mockReturnValue(true);enabled.mockReturnValue(true);compose.mockReturnValue(c);preview.mockResolvedValue({preview:true});reserve.mockResolvedValue({id:id(2)});processOriginal.mockResolvedValue({requestId:id(2),held:true});cancel.mockResolvedValue({canceled:true});read.mockResolvedValue({original:true});});
test("foreign origin cannot authenticate or start a refund",async()=>{expect((await POST(request(body,"https://foreign.invalid"))).status).toBe(403);expect(auth).not.toHaveBeenCalled();});
test("persisted admin permission is required before provider composition",async()=>{auth.mockRejectedValueOnce(Error("denied"));expect((await POST(request())).status).toBe(403);expect(compose).not.toHaveBeenCalled();});
test("uninstalled refund schema is unavailable before provider composition",async()=>{schema.mockReturnValue(false);expect((await POST(request())).status).toBe(404);expect(compose).not.toHaveBeenCalled();});
test("held source admits original GET-only recovery but refuses a new dispatch",async()=>{
 enabled.mockReturnValue(false);expect((await POST(request())).status).toBe(409);expect(compose).not.toHaveBeenCalled();
 expect((await POST(request({action:"recover",requestId:id(2)}))).status).toBe(200);expect(processOriginal).toHaveBeenCalledWith(c,id(29),id(2),false);expect(reserve).not.toHaveBeenCalled();
});
test("preview never reserves or dispatches a provider refund",async()=>{
 expect((await POST(request({action:"preview",receiptId:id(1),amountCents:1000,responsibility:"creator",reasonCode:"creator_discretionary"}))).status).toBe(200);expect(preview).toHaveBeenCalledWith(c,id(29),id(1),1000,"creator","creator_discretionary");expect(processOriginal).not.toHaveBeenCalled();expect(reserve).not.toHaveBeenCalled();
});
test("explicit confirmation freezes exact reviewed identities and verified actor",async()=>{
 const response=await POST(request());expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("private, no-store");
 expect(reserve).toHaveBeenCalledWith(c,{actorId:id(29),requestId:id(2),receiptId:id(1),expectedRevision:7,amountCents:1000,responsibility:"creator",reasonCode:"creator_discretionary"});expect(processOriginal).toHaveBeenCalledWith(c,id(29),id(2),true);
});
test.each([{confirm:false},{expectedRevision:1.5},{amountCents:1.5},{chargeId:"ch_forged"},{actorId:id(4)},{responsibility:"platform"}])("invalid or changed confirmation cannot reserve the original: %o",async extra=>{expect((await POST(request({...body,...extra}))).status).toBe(400);expect(reserve).not.toHaveBeenCalled();expect(processOriginal).not.toHaveBeenCalled();});
test("canceling an unstarted request is explicit and has no dispatch path",async()=>{expect((await POST(request({action:"cancel_unsent",requestId:id(2),confirm:true}))).status).toBe(200);expect(cancel).toHaveBeenCalledWith(c,id(29),id(2));expect(processOriginal).not.toHaveBeenCalled();});
test("saved status is private and never advances a provider operation",async()=>{const response=await GET(new NextRequest(`https://fixture.invalid/api/admin/sales-team/refunds?request_id=${id(2)}`));expect(response.status).toBe(200);expect(processOriginal).not.toHaveBeenCalled();expect(read).toHaveBeenCalledWith(c,id(29),id(2));});
