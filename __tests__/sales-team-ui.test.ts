/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
let viewer="member",query=new URLSearchParams("creator_id=creator");const push=jest.fn();
jest.mock("@/lib/useUser",()=>({useUser:()=>({userId:viewer,session:{access_token:"verified-session"},loading:false})}));
jest.mock("next/navigation",()=>({useSearchParams:()=>query,useRouter:()=>({push})}));
import SalesTeamDashboard from "@/components/SalesTeamDashboard";
import {MemberTermsControl} from "@/components/SalesTeamManagementControls";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement;const fetchMock=jest.fn(),originalFetch=global.fetch;
const member={id:"membership",user_id:"member",role:"closer",is_closer:true,status:"active",commission_bps:1000,hold_days:14,renewal_rule:"initial_commitment",commission_revision:1,accepted_commission_revision:null};
let team:Record<string,unknown>;
const response=(data:unknown,ok=true)=>({ok,json:async()=>data});
const mount=async()=>{await act(async()=>{root.render(createElement(SalesTeamDashboard));await new Promise(resolve=>setTimeout(resolve,30));});await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});};
beforeEach(()=>{
 viewer="member";query=new URLSearchParams("creator_id=creator");jest.clearAllMocks();container=document.createElement("div");document.body.append(container);root=createRoot(container);global.fetch=fetchMock;
 team={creatorId:"creator",role:"closer",membershipId:"membership",members:[member],invitations:[],targets:[],bindings:[],readiness:[{membershipId:"membership",ready:false}],enabled:true,routingEnabled:false};
 fetchMock.mockImplementation(async(path:string,options?:RequestInit)=>{
  if(options?.method==="POST")return response({result:{id:"membership"}});
  if(path==="/api/sales-team")return response({memberships:[{creator_id:"creator",role:"closer",status:"active"}]});
  if(path.startsWith("/api/bookings/list"))return response({bookings:[]});
  return response(team);
 });
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();global.fetch=originalFetch;});
test("a closer sees only their own agreement and cannot access team management controls",async()=>{
 await mount();expect(container.textContent).toContain("Your commission agreement");expect(container.textContent).toContain("10.00%");
 expect(container.textContent).not.toContain("Invite a team member");expect(container.textContent).not.toContain("Members and destinations");
 expect(container.textContent).toContain("Payout setup or recipient verification is still required");
 const button=Array.from(container.querySelectorAll("button")).find(b=>b.textContent==="Accept commission terms")!;expect(button.disabled).toBe(true);
 await act(async()=>{container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();});expect(button.disabled).toBe(false);
 await act(async()=>{button.click();});const post=fetchMock.mock.calls.find(([,options])=>options?.method==="POST");expect(JSON.parse(post![1].body)).toEqual({action:"accept_terms",revision:1,version:"creatornet-team-commission-v1",accepted:true,creator_id:"creator"});
});
test("a manager may invite closers while manager appointment remains creator-only",async()=>{
 team={...team,role:"manager",members:[{...member,role:"manager",is_closer:false}]};await mount();
 expect(container.textContent).toContain("Invite a team member");const roleOptions=Array.from(container.querySelectorAll("option")).map(o=>o.textContent);
 expect(roleOptions).toContain("Closer");expect(roleOptions).not.toContain("Manager");
 expect(container.textContent).not.toContain("This manager also closes sales");
});
test("displaying an invitation does not accept membership or commission terms automatically",async()=>{
 query=new URLSearchParams(`creator_id=creator&invitation=${"a".repeat(64)}`);team={...team,enabled:false};await mount();
 expect(container.textContent).toContain("Accept invitation");expect(fetchMock.mock.calls.some(([,options])=>options?.method==="POST")).toBe(false);
 expect(Array.from(container.querySelectorAll("button")).find(b=>b.textContent==="Accept commission terms")?.disabled).toBe(true);
});
test("a failed team read shows a recoverable error and does not render stale management data",async()=>{
 fetchMock.mockResolvedValue(response({error:"Your team access has changed."},false));await mount();
 expect(container.querySelector('[role="alert"]')?.textContent).toBe("Your team access has changed.");expect(container.textContent).toContain("Retry loading");expect(container.textContent).not.toContain("Invite a team member");
});

test("future-term edits carry the reviewed revision and explain prospective acceptance",async()=>{
 const save=jest.fn(async()=>undefined);
 await act(async()=>{root.render(createElement(MemberTermsControl,{member:{...member,role:"closer",commission_revision:7},owner:false,disabled:false,onChange:save}));});
 expect(container.textContent).toContain("Existing agreements keep their saved terms");
 expect(container.querySelectorAll("option").length).toBe(2);expect(container.textContent).not.toContain("Member role");
 await act(async()=>{container.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});
 expect(save).toHaveBeenCalledWith({action:"configure_member",membership_id:"membership",expected_revision:7,role:"closer",is_closer:true,commission_bps:1000,hold_days:14,renewal_rule:"initial_commitment"});
});
test("manager booking assignment controls disappear once sale attribution is frozen",async()=>{
 team={...team,role:"manager",readiness:[{membershipId:"membership",ready:true}]};
 const serve=fetchMock.getMockImplementation()!;let accepted:string|null=null;
 fetchMock.mockImplementation((path:string,options?:RequestInit)=>path.startsWith("/api/bookings/list")?Promise.resolve(response({bookings:[{
  booking:{id:"booking",status:"booked",created_at:"now"},post:{title:"Booked offer"},buyer:{full_name:"Customer"},assignment:{membership_id:"membership",source:"manual",accepted_sale_id:accepted}}]})):serve(path,options));
 await mount();expect(container.textContent).toContain("Assign an eligible closer");
 accepted="accepted-sale";await act(async()=>{root.unmount();root=createRoot(container);});await mount();
 expect(container.textContent).toContain("Sale attribution fixed");expect(container.textContent).not.toContain("Assign an eligible closer");
});
