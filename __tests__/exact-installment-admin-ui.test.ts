/** @jest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InstallmentReview } from "../app/admin/commerce/installments/InstallmentReview";
import type { ExactAdminPage } from "../lib/installments/adminView";
jest.mock("next/link",()=>({__esModule:true,default:({href,children,...props}:React.AnchorHTMLAttributes<HTMLAnchorElement>)=>React.createElement("a",{href,...props},children)}));
const initial:ExactAdminPage={plans:[{id:"77777777-7777-4777-8777-777777777777",title:"Synthetic mentorship",status:"active",totalCents:199900,
  paymentCount:3,purchaseId:null,holds:["invoice_recovery"],recoveries:[{outcome:"payment_pending",observedAt:null}],stop:null}],nextCursor:null};
let container:HTMLDivElement,root:Root;
const fetchMock=jest.fn();
beforeEach(async()=>{
  (globalThis as Record<string,unknown>).IS_REACT_ACT_ENVIRONMENT=true;
  global.fetch=fetchMock;fetchMock.mockReset();container=document.createElement("div");document.body.append(container);root=createRoot(container);
  await act(async()=>{root.render(React.createElement(InstallmentReview,{initial}));});
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
const button=(name:string)=>Array.from(container.querySelectorAll("button")).find(b=>b.textContent===name)!;
async function choose(){await act(async()=>button("Stop future billing").click());}
test("read-only render has clear scope and requires confirmation before submission",async()=>{
  expect(fetchMock).not.toHaveBeenCalled();expect(container.textContent).toContain("Payment outcome pending — do not retry");
  expect(container.textContent).toContain("does not issue a refund");
  await choose();expect(button("Confirm billing stop").disabled).toBe(true);expect(fetchMock).not.toHaveBeenCalled();
  await act(async()=>(container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  expect(button("Confirm billing stop").disabled).toBe(false);
});
test("only an explicit checked confirmation sends a request and 202 is not described as stopped",async()=>{
  await choose();await act(async()=>(container.querySelector("input") as HTMLInputElement).click());
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({status:"reconciliation_required"})})
    .mockResolvedValueOnce({ok:true,json:async()=>initial});
  await act(async()=>button("Confirm billing stop").click());
  expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/installments");
  const b=JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(b).toEqual({agreementId:initial.plans[0].id,requestId:expect.any(String),confirmation:"STOP_FUTURE_BILLING"});
  expect(b).not.toHaveProperty("actorId");expect(container.textContent).toContain("The stop is not confirmed");
});
test("a lost response does not announce success or silently resubmit",async()=>{
  await choose();await act(async()=>(container.querySelector("input") as HTMLInputElement).click());
  fetchMock.mockRejectedValueOnce(new Error("SECRET"));await act(async()=>button("Confirm billing stop").click());
  expect(fetchMock).toHaveBeenCalledTimes(1);expect(container.textContent).toContain("Refresh records");
  expect(container.textContent).not.toContain("SECRET");expect(button("Confirm billing stop").disabled).toBe(true);
  const checkbox=container.querySelector("input") as HTMLInputElement;
  expect(checkbox.disabled).toBe(true);
  await act(async()=>checkbox.click());
  expect(button("Confirm billing stop").disabled).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({...initial,plans:[{...initial.plans[0],
    stop:{requestId:JSON.parse(fetchMock.mock.calls[0][1].body).requestId,status:"running",ownedByCaller:true}}]})});
  await act(async()=>button("Refresh records").click());
  expect(button("Review saved stop").disabled).toBe(false);
  expect(fetchMock.mock.calls[1][1]).not.toHaveProperty("method");
});
test("completed or other-admin stops cannot be submitted",async()=>{
  for(const [status,ownedByCaller] of [["complete",true],["running",false]] as const){
    await act(async()=>root.render(React.createElement(InstallmentReview,{key:status,initial:{...initial,plans:[{...initial.plans[0],
      stop:{requestId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",status,ownedByCaller}}]}})));
    expect(button(status==="complete"?"Billing stopped":"Review saved stop").disabled).toBe(true);
  }
  expect(fetchMock).not.toHaveBeenCalled();
});
