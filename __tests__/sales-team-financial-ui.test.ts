/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
const refresh=jest.fn();
jest.mock("next/navigation",()=>({useRouter:()=>({refresh})}));
import FinancialControls from "@/app/admin/commerce/sales-team/FinancialControls";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement;const mockFetch=jest.fn(),originalFetch=global.fetch;
beforeEach(()=>{jest.clearAllMocks();container=document.createElement("div");document.body.append(container);root=createRoot(container);global.fetch=mockFetch;Object.defineProperty(globalThis.crypto,"randomUUID",{configurable:true,value:()=>"00000000-0000-4000-8000-000000000099"});});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();global.fetch=originalFetch;});
const render=async(reviewEnabled=true)=>{await act(async()=>root.render(createElement(FinancialControls,{receiptId:"original-receipt",revision:7,refunds:[{id:"re_original",amountCents:1000}],reviewEnabled})));};
const select=async(index:number,value:string)=>{await act(async()=>{const target=container.querySelectorAll("select")[index];target.value=value;target.dispatchEvent(new Event("change",{bubbles:true}));});};
const click=async(index:number)=>{await act(async()=>container.querySelectorAll("button")[index].click());};
test("unknown inspection retains the same request identity and does not claim bank payout",async()=>{
 mockFetch.mockRejectedValueOnce(Error("unknown")).mockResolvedValueOnce({ok:true,json:async()=>({held:false})});await render();await click(0);await click(0);
 const sent=mockFetch.mock.calls.map(([,options])=>JSON.parse(options.body));expect(sent[0]).toEqual(sent[1]);expect(sent[0]).toMatchObject({action:"inspect",receiptId:"original-receipt"});
 expect(container.textContent).toContain("Bank payout is not confirmed");expect(refresh).toHaveBeenCalledTimes(1);
});
test("refund cost bearer and reason require an explicit decision before permanent review",async()=>{
 mockFetch.mockResolvedValue({ok:true,json:async()=>({holdRetained:true})});await render();expect(container.querySelectorAll("button")[1].disabled).toBe(true);
 await select(0,"re_original");await select(1,"platform");expect(container.textContent).toContain("CreatorNet bears");
 expect([...container.querySelectorAll("select")[2].options].some(o=>o.value==="creator_non_delivery")).toBe(false);
 await select(2,"platform_technical_error");await click(1);
 expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({action:"review_refund",refundId:"re_original",responsibility:"platform",reasonCode:"platform_technical_error",expectedRevision:7});
 expect(container.textContent).toContain("Inspect this receipt again");
});
test("held review source exposes inspection only",async()=>{await render(false);expect(container.querySelectorAll("select")).toHaveLength(0);expect(container.querySelectorAll("button")).toHaveLength(1);});
