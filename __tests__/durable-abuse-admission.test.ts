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

const upload = {operation:"stable-operation",contract:"size-and-mime",resource:"new-resource",bytes:100};
const legacyHashes = {
 p_actor:"51bf96bc65b3181ae98a9e3ff204fbae80d5fb85df7771f9ac238a8f742e5873",
 p_ip:"a41a4de259f0070e458b656ed00b421a44a1c4edf55beb5ca93f1c551ef9d582",
 p_operation:"3212a31745277e3f5af60e90b261fd19c476c20951b3e5843330a6400e31949a",
 p_contract:"0816e7db820c9589b6e4133ec1c2f7a026ae998217c5c729c1b0cb3adca8db77",
};
test("unset HMAC setting preserves exact legacy upload identities and RPC shape",async()=>{
 mockRpc.mockResolvedValue({data:{allowed:true,reused:true,resource:"original-resource"},error:null});
 await admitRequest(request(),"public_upload","user:verified",upload);
 expect(mockRpc).toHaveBeenCalledTimes(1);
 expect(mockRpc).toHaveBeenCalledWith("abuse_admit_v1",{
  p_action:"public_upload",...legacyHashes,p_resource:"new-resource",p_bytes:100,p_seconds:0,
 });
});
test("API-key rotation with a fixed HMAC key preserves all reservation identities and original recovery resource",async()=>{
 process.env.ABUSE_HMAC_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
 mockRpc.mockResolvedValue({data:{allowed:true,reused:true,resource:"original-resource"},error:null});
 expect(await admitRequest(request(),"public_upload","user:verified",upload)).toEqual({resource:"original-resource",reused:true});
 process.env.SUPABASE_SERVICE_ROLE_KEY="sb_secret_synthetic-replacement-api-key";
 process.env.EMAIL_CODE_HMAC_KEY="unrelated-email-code-hmac-key-for-test";
 process.env.DISCOVER_ACTOR_HMAC_KEY="unrelated-discover-actor-hmac-key-for-test";
 expect(await admitRequest(request(),"public_upload","user:verified",upload)).toEqual({resource:"original-resource",reused:true});
 expect(mockRpc).toHaveBeenCalledTimes(2);
 expect(mockRpc.mock.calls[1]).toEqual(mockRpc.mock.calls[0]);
 expect(mockRpc.mock.calls[1][1]).toMatchObject(legacyHashes);
});
test("independent HMAC material replaces legacy identity derivation with one admission",async()=>{
 process.env.ABUSE_HMAC_KEY="synthetic-independent-abuse-hmac-key";
 mockRpc.mockResolvedValue({data:{allowed:true,reused:false,resource:"new-resource"},error:null});
 await admitRequest(request(),"public_upload","user:verified",upload);
 expect(mockRpc).toHaveBeenCalledTimes(1);
 for(const field of Object.keys(legacyHashes)) expect(mockRpc.mock.calls[0][1][field]).not.toBe(legacyHashes[field as keyof typeof legacyHashes]);
 expect(JSON.stringify(mockRpc.mock.calls[0][1])).not.toContain(process.env.ABUSE_HMAC_KEY);
});
test.each(["","short","x".repeat(31)])("invalid explicit HMAC setting fails closed without falling back: %p",async key=>{
 process.env.ABUSE_HMAC_KEY=key;
 await expect(admitRequest(request(),"public_upload","user:verified",upload)).rejects.toMatchObject({status:503});
 expect(mockRpc).not.toHaveBeenCalled();
});
