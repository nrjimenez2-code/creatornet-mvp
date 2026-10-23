const mockRpc = jest.fn();
const mockAuth = jest.fn();
jest.mock("@/lib/supabaseAdmin",()=>({supabaseAdmin:{rpc:(...args:unknown[])=>({abortSignal:()=>mockRpc(...args)})}}));
jest.mock("@/lib/supabaseConnectAuth",()=>({getAuthenticatedUser:(...args:unknown[])=>mockAuth(...args)}));
import { admitRequest, AdmissionError, admissionResponse, trustedClientIp } from "@/lib/abuse/admission";
let replacement: ReturnType<typeof jest.replaceProperty>;
beforeEach(()=>{
 replacement=jest.replaceProperty(process,"env",{NODE_ENV:"production",VERCEL:"1",SUPABASE_SERVICE_ROLE_KEY:"FAKE_SERVICE_ONLY_KEY_FOR_SYNTHETIC_TESTS"});
 mockRpc.mockReset().mockResolvedValue({data:{allowed:true,reused:false,resource:null},error:null});
 mockAuth.mockReset().mockResolvedValue({id:"verified-user"});
});
afterEach(()=>replacement.restore());
const request=(headers:Record<string,string>={"x-vercel-forwarded-for":"203.0.113.7"})=>new Request("https://app.test/api/feed",{headers});
test("generic forwarded IP cannot choose a production quota identity",()=>{
 expect(()=>trustedClientIp(request({"x-forwarded-for":"1.2.3.4"}))).toThrow(AdmissionError);
 expect(()=>trustedClientIp(request({"x-vercel-forwarded-for":"203.0.113.7,1.2.3.4"}))).toThrow(AdmissionError);
 expect(trustedClientIp(request({"x-vercel-forwarded-for":"2001:0db8:0:0::1"}))).toBe("2001:db8::1");
});
test("only domain-separated hashes reach the durable RPC",async()=>{
 await admitRequest(request(),"feed_page");
 const [action,args]=mockRpc.mock.calls[0];expect(action).toBe("abuse_admit_v1");
 expect(args).toMatchObject({p_action:"feed_page",p_actor:expect.stringMatching(/^[a-f0-9]{64}$/),p_ip:expect.stringMatching(/^[a-f0-9]{64}$/)});
 expect(args.p_actor).not.toBe(args.p_ip);expect(JSON.stringify(args)).not.toMatch(/203\.0\.113|verified-user|FAKE_SERVICE/);
 expect(mockAuth).toHaveBeenCalledWith(expect.anything(),{readOnlyAuthCookies:true});
});
test("anonymous IP identity shares the broad NAT budget, while a signed feed actor remains distinct",async()=>{
 mockAuth.mockResolvedValue(null);await admitRequest(request(),"search");
 let args=mockRpc.mock.calls[0][1];expect(args.p_actor).toBe(args.p_ip);
 await admitRequest(request(),"feed_page","anon:signed-actor");args=mockRpc.mock.calls[1][1];expect(args.p_actor).not.toBe(args.p_ip);
});
test.each([{error:{code:"XX000"},data:null},{error:null,data:null},{error:null,data:{allowed:"true"}}])("unavailable/malformed admission fails closed: %p",async result=>{
 mockRpc.mockResolvedValue(result);await expect(admitRequest(request(),"feed_page")).rejects.toMatchObject({status:503});
});
test("timeouts fail closed and quota denial carries a bounded Retry-After",async()=>{
 mockRpc.mockRejectedValueOnce(Error("timeout"));await expect(admitRequest(request(),"feed_page")).rejects.toMatchObject({status:503});
 mockRpc.mockResolvedValue({data:{allowed:false,retry_after:65},error:null});
 try{await admitRequest(request(),"feed_page");throw Error("unexpected admission");}catch(error){
  expect(error).toMatchObject({status:429,retryAfter:65});const response=admissionResponse(error)!;expect(response.status).toBe(429);expect(response.headers.get("Retry-After")).toBe("65");
 }
});
test("upload recovery requires a durable resource and preserves its exact identity",async()=>{
 const upload={operation:"stable-operation",contract:"size-and-mime",resource:"new-resource",bytes:100};
 mockRpc.mockResolvedValueOnce({data:{allowed:true,reused:true,resource:"original-resource"},error:null});
 expect(await admitRequest(request(),"public_upload","user:verified",upload)).toEqual({resource:"original-resource",reused:true});
 mockRpc.mockResolvedValueOnce({data:{allowed:true},error:null});
 await expect(admitRequest(request(),"public_upload","user:verified",upload)).rejects.toMatchObject({status:503});
});
