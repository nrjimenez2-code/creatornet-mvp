/** @jest-environment jsdom */
import {act,createElement,StrictMode} from "react";
import {createRoot,type Root} from "react-dom/client";
const actor="00000000-0000-4000-8000-000000000002",creator="00000000-0000-4000-8000-000000000001",request="00000000-0000-4000-8000-000000003001";
const review="00000000-0000-4000-8000-000000003002",review2="00000000-0000-4000-8000-000000003003";
const session=jest.fn();
jest.mock("@/lib/useUser",()=>({useUser:()=>({session:{access_token:"fixture-token"}})}));
jest.mock("@/lib/actionSession",()=>({getActionSession:(...args:unknown[])=>session(...args)}));
import Actions from "@/components/SalesTeamBankReviewActions";
import {bankReviewStorageKey,readBankReviewIntent,bankReviewBody,type BankReviewIntent} from "@/lib/salesTeams/bankReviewIntent";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const scope={actor,creator,request},key=bankReviewStorageKey(scope),hash="a".repeat(64),recorded=jest.fn();
let root:Root,container:HTMLDivElement;const fetchMock=jest.fn(),originalFetch=global.fetch;
const pending=(action="acknowledged")=>({...scope,version:1,reviewId:review,action,stateSha256:hash});
const success=(recorded=true)=>({ok:true,status:200,json:async()=>({reviewId:review,recorded,bankConfirmed:false,outstanding:true})});
const settle=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});};
const render=async(props:Partial<Parameters<typeof Actions>[0]>={},strict=false)=>{
 await act(async()=>{const component=createElement(Actions,{userId:actor,creator,request,stateSha256:hash,canReview:true,onRecorded:recorded,...props});root.render(strict?createElement(StrictMode,null,component):component);});await settle();
};
const button=(name:string)=>Array.from(container.querySelectorAll("button")).find(b=>b.textContent===name)!;
const click=async(name:string)=>{expect(button(name)).toBeDefined();await act(async()=>button(name).click());await settle();};
beforeEach(()=>{
 jest.clearAllMocks();window.sessionStorage.clear();session.mockResolvedValue({data:{session:{user:{id:actor}}},error:null});
 jest.spyOn(crypto,"randomUUID").mockReturnValue(review);
 container=document.createElement("div");document.body.append(container);root=createRoot(container);global.fetch=fetchMock;fetchMock.mockResolvedValue(success());
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();global.fetch=originalFetch;jest.restoreAllMocks();window.sessionStorage.clear();});
test("mount, strict remount and held capability never acquire an action session or POST",async()=>{
 await render({canReview:false},true);expect(session).not.toHaveBeenCalled();expect(fetchMock).not.toHaveBeenCalled();
 expect(button("Acknowledge observation").disabled).toBe(true);await click("Acknowledge observation");expect(session).not.toHaveBeenCalled();
 expect(container.textContent).toContain("bank receipt unconfirmed");expect(container.textContent).not.toContain("Confirm deposit");
});
test.each([["Acknowledge observation","acknowledged"],["Escalate observation","escalated"]])("%s persists exact scoped intent before one authenticated POST",async(label,action)=>{
 fetchMock.mockImplementation(async(_path:string,options:RequestInit)=>{
  const saved=JSON.parse(window.sessionStorage.getItem(key)!);expect(saved.action).toBe(action);
  expect(JSON.parse(String(options.body))).toEqual({creator_id:creator,request_id:request,review_id:review,action,state_sha256:hash});return success();
 });
 await render();await click(label);expect(session).toHaveBeenCalledTimes(1);expect(fetchMock).toHaveBeenCalledTimes(1);
 expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer fixture-token");expect(window.sessionStorage.getItem(key)).toBeNull();expect(recorded).toHaveBeenCalledTimes(1);
});
test("double click during session verification yields one original submission",async()=>{
 let resolve!:(v:unknown)=>void;session.mockImplementation(()=>new Promise(r=>{resolve=r;}));await render();
 await act(async()=>{button("Acknowledge observation").click();button("Acknowledge observation").click();});expect(session).toHaveBeenCalledTimes(1);
 await act(async()=>resolve({data:{session:{user:{id:actor}}},error:null}));await settle();expect(fetchMock).toHaveBeenCalledTimes(1);
});
test.each([{data:{session:null},error:null},{data:{session:{user:{id:creator}}},error:null},{data:{session:{user:{id:actor}}},error:Error("expired")}])("missing, switched or errored action identity stops before storage/POST",async value=>{
 session.mockResolvedValue(value);await render();await click("Acknowledge observation");expect(fetchMock).not.toHaveBeenCalled();expect(window.sessionStorage.getItem(key)).toBeNull();expect(container.textContent).toContain("signed-in account changed");
});
test("sign-out/unmount during action identity check prevents dispatch",async()=>{
 let resolve!:(v:unknown)=>void;session.mockImplementation(()=>new Promise(r=>{resolve=r;}));await render();
 await act(async()=>button("Acknowledge observation").click());await act(async()=>root.render(createElement("p",null,"Signed out")));
 await act(async()=>resolve({data:{session:{user:{id:actor}}},error:null}));await settle();expect(fetchMock).not.toHaveBeenCalled();expect(window.sessionStorage.getItem(key)).toBeNull();
});
test("ambiguous network outcome retains original action/hash/ID across a newer read and explicit retry",async()=>{
 fetchMock.mockRejectedValueOnce(new TypeError("Network interrupted"));await render();await click("Acknowledge observation");
 const first=JSON.parse(fetchMock.mock.calls[0][1].body);expect(window.sessionStorage.getItem(key)).not.toBeNull();expect(recorded).not.toHaveBeenCalled();
 expect(button("Escalate observation")).toBeUndefined();await render({stateSha256:"b".repeat(64)});expect(fetchMock).toHaveBeenCalledTimes(1);
 fetchMock.mockResolvedValueOnce(success(false));await click("Retry original review request");
 expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(first);expect(window.sessionStorage.getItem(key)).toBeNull();expect(recorded).toHaveBeenCalledTimes(1);
});
test("a saved original survives remount without automatic replay and only its scoped intent is sent",async()=>{
 window.sessionStorage.setItem(key,JSON.stringify(pending("escalated")));await render();
 expect(session).not.toHaveBeenCalled();expect(fetchMock).not.toHaveBeenCalled();expect(container.textContent).toContain("original escalation");
 await click("Retry original review request");expect(JSON.parse(fetchMock.mock.calls[0][1].body).action).toBe("escalated");expect(recorded).toHaveBeenCalledTimes(1);
});
test("storage failure before dispatch sends no POST and creates no uncertain original",async()=>{
 await render();jest.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw Error("Storage unavailable");});
 await click("Acknowledge observation");expect(fetchMock).not.toHaveBeenCalled();expect(window.sessionStorage.getItem(key)).toBeNull();expect(container.textContent).toContain("Storage unavailable");
});
test.each(["{",JSON.stringify({...pending(),actor:creator}),"x".repeat(2049),JSON.stringify({...pending(),action:"confirmed"}),JSON.stringify({...pending(),provider_id:"po_private"})])("corrupt or foreign saved intent is held without parsing arbitrary data into a POST",async raw=>{
 window.sessionStorage.setItem(key,raw);await render();expect(container.textContent).toContain("needs reconciliation");expect(button("Acknowledge observation").disabled).toBe(true);
 await click("Acknowledge observation");expect(session).not.toHaveBeenCalled();expect(fetchMock).not.toHaveBeenCalled();expect(window.sessionStorage.getItem(key)).toBe(raw);
});
test.each([{reviewId:review,recorded:true,bankConfirmed:true,outstanding:false},{reviewId:review2,recorded:true,bankConfirmed:false,outstanding:true},{reviewId:review,recorded:"yes",bankConfirmed:false,outstanding:true}])("unrecognized success result retains the original and never announces a confirmed review",async value=>{
 fetchMock.mockResolvedValueOnce({ok:true,status:200,json:async()=>value});await render();await click("Acknowledge observation");
 expect(recorded).not.toHaveBeenCalled();expect(window.sessionStorage.getItem(key)).not.toBeNull();expect(button("Retry original review request")).toBeDefined();
});
test("only a proven state-changed rejection clears original; stale displayed hash remains held until fresh read",async()=>{
 fetchMock.mockResolvedValueOnce({ok:false,status:409,json:async()=>({code:"BANK_REVIEW_ACTION_STATE_CHANGED",error:"Refresh current observation"})});await render();await click("Acknowledge observation");
 expect(window.sessionStorage.getItem(key)).toBeNull();expect(button("Acknowledge observation").disabled).toBe(true);expect(container.textContent).toContain("was not recorded");expect(recorded).not.toHaveBeenCalled();
 jest.mocked(crypto.randomUUID).mockReturnValue(review2);await render({stateSha256:"b".repeat(64)});
 fetchMock.mockResolvedValueOnce({ok:true,status:200,json:async()=>({reviewId:review2,recorded:true,bankConfirmed:false,outstanding:true})});await click("Escalate observation");
 expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({review_id:review2,action:"escalated",state_sha256:"b".repeat(64)});expect(recorded).toHaveBeenCalledTimes(1);
});
test.each([["BANK_REVIEW_AUTHORITY_REQUIRED",409],["ORIGINAL_BANK_REVIEW_REQUIRED",409],["BANK_REVIEW_STATE_CHANGED",409],["BANK_REVIEW_ACTION_ISOLATION_REQUIRED",409],["BANK_REVIEW_ACTION_STATE_CHANGED",500]])("%s/%s cannot clear an uncertain original",async(code,status)=>{
 fetchMock.mockResolvedValueOnce({ok:false,status,json:async()=>({code,error:"Needs reconciliation"})});await render();await click("Acknowledge observation");
 expect(window.sessionStorage.getItem(key)).not.toBeNull();expect(recorded).not.toHaveBeenCalled();expect(button("Retry original review request")).toBeDefined();
});
test("failure to clear a known recorded original keeps same-ID retry instead of allowing replacement intent",async()=>{
 await render();jest.spyOn(Storage.prototype,"removeItem").mockImplementation(()=>{throw Error("Storage cleanup unavailable");});await click("Acknowledge observation");
 expect(recorded).not.toHaveBeenCalled();expect(window.sessionStorage.getItem(key)).not.toBeNull();expect(button("Retry original review request")).toBeDefined();expect(button("Escalate observation")).toBeUndefined();
});
test("a changed stored original cannot replace the mounted pending intent",async()=>{
 window.sessionStorage.setItem(key,JSON.stringify(pending()));await render();window.sessionStorage.setItem(key,JSON.stringify({...pending(),reviewId:review2}));
 await click("Retry original review request");expect(fetchMock).not.toHaveBeenCalled();expect(container.textContent).toContain("saved original review request changed");
});
test("late POST completion after scoped unmount preserves original and never updates the new view",async()=>{
 let resolve!:(v:unknown)=>void;fetchMock.mockImplementation(()=>new Promise(r=>{resolve=r;}));await render();
 await act(async()=>button("Acknowledge observation").click());await settle();expect(window.sessionStorage.getItem(key)).not.toBeNull();
 await act(async()=>root.render(createElement("p",null,"Different signed-in account")));await act(async()=>resolve(success()));await settle();
 expect(recorded).not.toHaveBeenCalled();expect(window.sessionStorage.getItem(key)).not.toBeNull();expect(container.textContent).toBe("Different signed-in account");
});
test("pure saved-intent reader rejects altered version/hash/scope and the POST body never contains actor",()=>{
 const value=readBankReviewIntent(JSON.stringify(pending()),scope)!;expect(bankReviewBody(value)).not.toHaveProperty("actor");expect(value).toMatchObject({reviewId:review,version:1});
 for(const bad of [{...pending(),version:2},{...pending(),stateSha256:"wrong"},{...pending(),reviewId:"wrong"}])expect(()=>readBankReviewIntent(JSON.stringify(bad),scope)).toThrow(/reconciliation/);
 expect(readBankReviewIntent(null,scope)).toBeNull();expect(value as BankReviewIntent).toBeDefined();
});
