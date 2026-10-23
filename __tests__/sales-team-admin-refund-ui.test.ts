/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
const refresh=jest.fn();jest.mock("next/navigation",()=>({useRouter:()=>({refresh})}));
import RefundControls from "@/app/admin/commerce/sales-team/RefundControls";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const receiptId="00000000-0000-4000-8000-000000000001",actorId="00000000-0000-4000-8000-000000000029",requestId="00000000-0000-4000-8000-000000000025";
let root:Root,container:HTMLDivElement;const mockFetch=jest.fn(),originalFetch=global.fetch,key=`cn:team-admin-refund:v1:test:${actorId}:${receiptId}`;
beforeEach(()=>{jest.clearAllMocks();sessionStorage.clear();container=document.createElement("div");document.body.append(container);root=createRoot(container);global.fetch=mockFetch;Object.defineProperty(globalThis.crypto,"randomUUID",{configurable:true,value:()=>requestId});});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();global.fetch=originalFetch;});
const render=async(enabled=true,requests:Parameters<typeof RefundControls>[0]["requests"]=[])=>{await act(async()=>{root.render(createElement(RefundControls,{actorId,receiptId,mode:"test",enabled,requests}));await new Promise(resolve=>setTimeout(resolve,10));});await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});};
const click=async(text:string)=>{const button=[...container.querySelectorAll("button")].find(b=>b.textContent===text);expect(button).toBeDefined();await act(async()=>button!.click());};
const change=async(selector:string,value:string)=>{await act(async()=>{const target=container.querySelector(selector) as HTMLInputElement|HTMLSelectElement;const setter=Object.getOwnPropertyDescriptor(target instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,"value")!.set!;setter.call(target,value);target.dispatchEvent(new Event(target instanceof HTMLSelectElement?"change":"input",{bubbles:true}));});};
async function review(){await change('input[inputmode="decimal"]',"10.00");await change("select:nth-of-type(1)","creator");await change("label:nth-of-type(3) select","creator_discretionary");await click("Preview current refund");}
test("preview is separate from money dispatch and requires explicit cost confirmation",async()=>{
 mockFetch.mockResolvedValue({ok:true,json:async()=>({receiptId,revision:7,amountCents:1000,responsibility:"creator",reasonCode:"creator_discretionary",originalProcessingShareCents:38})});await render();await review();
 expect(mockFetch).toHaveBeenCalledTimes(1);expect(JSON.parse(mockFetch.mock.calls[0][1].body).action).toBe("preview");const send=[...container.querySelectorAll("button")].find(b=>b.textContent==="Send reviewed refund")!;expect(send.disabled).toBe(true);expect(container.textContent).toContain("$0.38");
});
test("unknown money response retains the original capsule and exact request on retry",async()=>{
 mockFetch.mockImplementation(async(_path:string,options:{body:string})=>{const body=JSON.parse(options.body);if(body.action==="preview")return {ok:true,json:async()=>({receiptId,revision:7,amountCents:1000,responsibility:"creator",reasonCode:"creator_discretionary",originalProcessingShareCents:38})};throw Error("synthetic unknown");});
 await render();await review();await act(async()=>container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());await click("Send reviewed refund");
 const stored=JSON.parse(sessionStorage.getItem(key)!);expect(stored.request.requestId).toBe(requestId);expect(stored.request).not.toHaveProperty("clientSecret");const sent=mockFetch.mock.calls.filter(([,options])=>JSON.parse(options.body).action==="create").map(([,options])=>JSON.parse(options.body));
 await click("Retry reviewed request");expect(JSON.parse(mockFetch.mock.calls.at(-1)![1].body)).toEqual(sent[0]);expect(container.textContent).toContain("saved identity is retained");
});
test("reloading a saved request offers recovery with new dispatch held",async()=>{
 sessionStorage.setItem(key,JSON.stringify({version:"team-admin-refund-v1",actorId,mode:"test",request:{action:"create",receiptId,requestId,expectedRevision:7,amountCents:1000,responsibility:"creator",reasonCode:"creator_discretionary",confirm:true}}));
 mockFetch.mockResolvedValue({ok:true,json:async()=>({requestId,disposition:"refund_pending",providerStatus:"pending",held:true})});await render(false);await click("Recover saved original outcome");
 expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({action:"recover",requestId});expect(sessionStorage.getItem(key)).not.toBeNull();
});
test("server-side original requests remain recoverable while new refunds are held",async()=>{
 mockFetch.mockResolvedValue({ok:true,json:async()=>({requestId,disposition:"not_dispatched",held:true})});await render(false,[{requestId,amountCents:1000,responsibility:"creator",reasonCode:"creator_discretionary",dispatchState:"not_dispatched",providerStatus:null,refundId:null,resolved:false,createdAt:"2026-10-22T00:00:00Z"}]);await click("Refresh original refund");expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({action:"recover",requestId});expect(container.textContent).not.toContain("Send reviewed refund");
});

const saveOriginal=()=>sessionStorage.setItem(key,JSON.stringify({version:"team-admin-refund-v1",actorId,mode:"test",request:{action:"create",receiptId,requestId,expectedRevision:7,amountCents:1000,responsibility:"creator",reasonCode:"creator_discretionary",confirm:true}}));
test("a failed refund with financial review outstanding retains the capsule and says reconciliation remains",async()=>{
 saveOriginal();mockFetch.mockResolvedValue({ok:true,json:async()=>({requestId,disposition:"refund_not_completed",providerStatus:"failed",held:true})});await render(false);await click("Recover saved original outcome");
 expect(sessionStorage.getItem(key)).not.toBeNull();expect(container.textContent).toContain("principal and costs still need financial review");expect(container.textContent).not.toContain("have been reconciled");
});
test("only a matching reconciled original can clear its saved request",async()=>{
 saveOriginal();mockFetch.mockResolvedValueOnce({ok:true,json:async()=>({requestId:receiptId,disposition:"refund_observed",held:false})});await render(false);await click("Recover saved original outcome");expect(sessionStorage.getItem(key)).not.toBeNull();
 mockFetch.mockResolvedValueOnce({ok:true,json:async()=>({requestId,disposition:"refund_not_completed",providerStatus:"failed",held:false})});await click("Recover saved original outcome");expect(sessionStorage.getItem(key)).toBeNull();expect(container.textContent).toContain("have been reconciled");
});
test("a request cannot dispatch if durable browser storage fails",async()=>{
 mockFetch.mockResolvedValue({ok:true,json:async()=>({receiptId,revision:7,amountCents:1000,responsibility:"creator",reasonCode:"creator_discretionary",originalProcessingShareCents:38})});await render();await review();await act(async()=>container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
 const storage=jest.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw Error("synthetic storage unavailable");});try{await click("Send reviewed refund");}finally{storage.mockRestore();}
 expect(mockFetch).toHaveBeenCalledTimes(1);expect(JSON.parse(mockFetch.mock.calls[0][1].body).action).toBe("preview");
});
