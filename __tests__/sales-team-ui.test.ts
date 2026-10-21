/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
let viewer="member",query=new URLSearchParams("creator_id=creator");const push=jest.fn();
jest.mock("@/lib/useUser",()=>({useUser:()=>({userId:viewer,session:{access_token:"verified-session"},loading:false})}));
jest.mock("next/navigation",()=>({useSearchParams:()=>query,useRouter:()=>({push})}));
import SalesTeamDashboard from "@/components/SalesTeamDashboard";
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
