/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
const api=jest.fn();jest.mock("@/lib/salesTeams/client",()=>({useTeamApi:()=>api}));
import Controls from "@/components/SalesTeamBookedOfferControls";
import Checkout from "@/components/SalesTeamBookingCheckout";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement;const saved=jest.fn();
beforeEach(()=>{jest.clearAllMocks();container=document.createElement("div");document.body.append(container);root=createRoot(container);api.mockImplementation(async(_path:string,body?:unknown)=>body?{}:{offers:[{id:"offer",title:"Booked course",type:"course",revision:3,attached:false}]});});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
async function open(enabled=true){await act(async()=>root.render(createElement(Controls,{creatorId:"creator",bookingId:"booking",enabled,onSaved:saved})));await act(async()=>container.querySelector("button")!.click());await act(async()=>{const select=container.querySelector("select")!;select.value="offer";select.dispatchEvent(new Event("change",{bubbles:true}));});}
test("unknown response preserves original attachment identity and price approval stays separate",async()=>{
 await open();api.mockRejectedValueOnce(Error("unknown"));await act(async()=>container.querySelectorAll("button")[1].click());
 const first=api.mock.calls.find(([,body])=>body)![1];expect(container.querySelector("select")!.disabled).toBe(true);expect(first).toMatchObject({booking_id:"booking",product_id:"offer",expected_revision:3,attached:true});expect(first).not.toHaveProperty("amount_cents");
 await act(async()=>container.querySelectorAll("button")[1].click());expect(api.mock.calls.filter(([,body])=>body).map(([,body])=>body)).toEqual([first,first]);expect(saved).toHaveBeenCalledTimes(1);expect(container.textContent).toContain("Price and payment choices require separate approval");
});
test("paused team activity allows reading but disables an attachment",async()=>{await open(false);expect(container.querySelectorAll("button")[1].disabled).toBe(true);expect(api.mock.calls.every(([,body])=>!body)).toBe(true);});
test("approved choices identify each attached offer when two products share the same price",async()=>{
 api.mockResolvedValue({offers:[{id:"first",title:"Course A"},{id:"second",title:"Course B"}],approvals:[{id:"a",amount_cents:1000},{id:"b",amount_cents:1000}],options:[{id:"one",product_id:"first",approval_id:"a",kind:"full",payment_count:1},{id:"two",product_id:"second",approval_id:"b",kind:"full",payment_count:1}]});
 await act(async()=>root.render(createElement(Checkout,{creatorId:"creator",bookingId:"booking",enabled:true})));
 const labels=[...container.querySelectorAll("option")].map(o=>o.textContent);expect(labels).toEqual(["Course A · $10.00 in full","Course B · $10.00 in full"]);
});
