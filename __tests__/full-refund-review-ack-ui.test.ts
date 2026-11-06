/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
import AcknowledgeReview from "../app/admin/commerce/full-refunds/AcknowledgeReview";
let root:Root,host:HTMLDivElement;const mockFetch=jest.fn();
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement("div");document.body.append(host);root=createRoot(host);
  jest.clearAllMocks();global.fetch=mockFetch as any;Object.defineProperty(crypto,"randomUUID",{configurable:true,value:()=>"10000000-0000-4000-8000-000000000001"});});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const render=async(revision=3)=>act(async()=>root.render(createElement(AcknowledgeReview,{eventId:"evt_original",revision,key:`evt_original:${revision}`})));
test("explicit review required; uncertain retry keeps original request; success retains hold warning",async()=>{
  await render();expect(host.querySelector("button")!.disabled).toBe(true);expect(mockFetch).not.toHaveBeenCalled();
  await act(async()=>host.querySelector("input")!.click());
  mockFetch.mockRejectedValueOnce(Error("lost response"));await act(async()=>host.querySelector("button")!.click());
  expect(host.textContent).toContain("Recording needs verification");
  mockFetch.mockResolvedValueOnce({ok:true,json:async()=>({status:"review_recorded_hold_retained",current:true})});
  await act(async()=>host.querySelector("button")!.click());
  expect(mockFetch.mock.calls[0][1].body).toBe(mockFetch.mock.calls[1][1].body);
  expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toMatchObject({eventId:"evt_original",revision:3,confirmHoldRetained:true});
  expect(host.textContent).toContain("Financial hold and backlog attention remain active");
  await render(4);expect(host.querySelector("button")!.disabled).toBe(true);expect(host.querySelector("input")!.checked).toBe(false);
});
test("double click cannot dispatch two pending acknowledgements",async()=>{
  let resolve!:(value:unknown)=>void;mockFetch.mockReturnValue(new Promise(r=>{resolve=r;}));
  await render();await act(async()=>host.querySelector("input")!.click());
  await act(async()=>{host.querySelector("button")!.click();host.querySelector("button")!.click();});expect(mockFetch).toHaveBeenCalledTimes(1);
  await act(async()=>resolve({ok:true,json:async()=>({status:"review_recorded_hold_retained",current:false})}));
  expect(host.textContent).toContain("older revision");
});
