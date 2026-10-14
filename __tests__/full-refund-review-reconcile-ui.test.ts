/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
import ReconcileRefund from "../app/admin/commerce/full-refunds/ReconcileRefund";
let root:Root,host:HTMLDivElement;const mockFetch=jest.fn();
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement("div");document.body.append(host);root=createRoot(host);
  jest.clearAllMocks();global.fetch=mockFetch as any;});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
test("explicit original-only reconciliation prevents double submission and retains hold after response",async()=>{
  let resolve!:(value:unknown)=>void;mockFetch.mockReturnValue(new Promise(r=>{resolve=r;}));
  await act(async()=>root.render(createElement(ReconcileRefund,{eventId:"evt_original",revision:3})));
  expect(host.querySelector("button")!.disabled).toBe(true);expect(mockFetch).not.toHaveBeenCalled();
  await act(async()=>host.querySelector("input")!.click());
  await act(async()=>{host.querySelector("button")!.click();host.querySelector("button")!.click();});expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({eventId:"evt_original",revision:3,confirmOriginalOnly:true});
  await act(async()=>resolve({ok:true,json:async()=>({status:"original_reconciled_hold_retained",holdRetained:true})}));
  expect(host.textContent).toContain("financial hold remains active");expect(host.querySelector("input")!.checked).toBe(false);
});
test("uncertain reconciliation does not display success or release permission",async()=>{
  mockFetch.mockRejectedValueOnce(Error("lost reply"));await act(async()=>root.render(createElement(ReconcileRefund,{eventId:"evt_original",revision:3})));
  await act(async()=>host.querySelector("input")!.click());await act(async()=>host.querySelector("button")!.click());
  expect(host.textContent).toContain("uncertainty cannot release the financial hold");expect(host.textContent).not.toContain("Original observation reconciled");
});
