/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
jest.mock("@/lib/useUser",()=>({useUser:()=>({userId:"creator",session:{access_token:"synthetic"}})}));
jest.mock("@/lib/supabaseClient",()=>({createClient:()=>({})}));
jest.mock("@/components/SchedulingConnections",()=>({__esModule:true,default:()=>null}));
import PostComposer from "@/components/PostComposer";
const originalFetch=globalThis.fetch;
let root:Root,container:HTMLDivElement,postingReady:boolean;
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
beforeEach(async()=>{
 jest.useFakeTimers();
 postingReady=true;
 globalThis.fetch=jest.fn(async(url:RequestInfo|URL)=>({ok:true,json:async()=>String(url).includes("/connect/status")?{onboarding_complete:true,tipping_enabled:true}:{items:[],capabilities:{premiumDelivery:true,premiumDeliveryReady:postingReady}}})) as unknown as typeof fetch;
 container=document.createElement("div");document.body.append(container);root=createRoot(container);
 await act(async()=>{root.render(createElement(PostComposer));});
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();globalThis.fetch=originalFetch;jest.useRealTimers();});
function selection(){return Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"]')).map(b=>b.textContent);}
function button(name:string){return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(b=>b.textContent===name)!;}
test("the compact group starts empty and has no None button or independent post price",()=>{
 expect(selection()).toEqual([]);expect(button("None")).toBeUndefined();
 expect(container.textContent).toContain("Video button");expect(container.textContent).not.toContain('Attach "Buy / Book"');
 expect(container.textContent).not.toContain("Enable tips on this free video");
 expect(container.querySelector('[aria-label="Product price in USD"]')).toBeNull();
});
test("switching each option leaves one pressed button and pressing again clears it",async()=>{
 for(const name of ["Buy","Book","Tip"]){
  await act(async()=>button(name).click());expect(selection()).toEqual([name]);
 }
 await act(async()=>button("Tip").click());expect(selection()).toEqual([]);
});
test("product setup is shown only for Buy and disappears on Book",async()=>{
 await act(async()=>button("Buy").click());expect(container.querySelector("select")).not.toBeNull();expect(button("New")).toBeDefined();
 await act(async()=>button("Book").click());expect(button("New")).toBeUndefined();expect(selection()).toEqual(["Book"]);
 await act(async()=>button("Book").click());expect(selection()).toEqual([]);
});
test("readiness off keeps the compact flow visible and disables new posting",async()=>{
 await act(async()=>root.unmount());postingReady=false;root=createRoot(container);
 await act(async()=>root.render(createElement(PostComposer)));
 for(const name of ["Buy","Book","Tip"])expect(button(name).disabled).toBe(true);
 expect(container.textContent).toContain("Purchased content remains available in Library");
 expect(container.textContent).not.toContain('Attach "Buy / Book"');
});
