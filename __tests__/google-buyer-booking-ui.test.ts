/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
let userId:string|null='buyer';let query=new URLSearchParams('cn_attribution=intent');
jest.mock("@/lib/useUser",()=>({useUser:()=>({userId,session:{access_token:'token'},loading:false})}));
jest.mock("next/navigation",()=>({useParams:()=>({connection:'connection'}),useSearchParams:()=>query}));
import Page from "@/app/scheduling/book/[connection]/page";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement;const fetchMock=jest.fn(),originalFetch=global.fetch;
const slot={start:'2026-10-01T10:00:00Z',end:'2026-10-01T10:30:00Z'};
beforeEach(()=>{
  userId='buyer';query=new URLSearchParams('cn_attribution=intent');window.history.replaceState(null,'','/scheduling/book/connection');
  fetchMock.mockReset().mockImplementation(async(url:string,init?:RequestInit)=>({ok:true,json:async()=>url.includes('/reservations/')?{reservation:{id:'reservation',status:'confirmed',revision:0,...slot}}:init?.method==='POST'?{reservation:{id:'reservation',status:'creating',revision:0,...slot}}:{title:'Consultation',timeZone:'UTC',durationMinutes:30,slots:[slot],reservation:null}}));
  global.fetch=fetchMock;container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();global.fetch=originalFetch;});
const click=async(text:string)=>{await act(async()=>{const button=Array.from(container.querySelectorAll('button')).find(value=>value.textContent===text);if(!button)throw new Error('Missing '+text);button.click();});};
test("buyer explicitly selects a time and sees pending until Google confirmation",async()=>{
  await act(async()=>root.render(createElement(Page)));
  expect((Array.from(container.querySelectorAll('button')).find(value=>value.textContent==='Book this time'))?.disabled).toBe(true);
  await act(async()=>{(container.querySelector('input[type=radio]') as HTMLInputElement).click();});await click('Book this time');
  expect(container.textContent).toContain('Confirming with Google Calendar');expect(container.textContent).not.toContain('Booking confirmed');
  const body=JSON.parse(fetchMock.mock.calls.find(([,init])=>init?.method==='POST')![1].body);
  expect(body).toMatchObject({...slot,attributionId:'intent'});expect(window.location.search).toContain('reservation_id=reservation');
  await click('Check status');expect(container.textContent).toContain('Booking confirmed');
});
test("signed-out visitors do not load another buyer's booking context",async()=>{
  userId=null;await act(async()=>root.render(createElement(Page)));expect(container.textContent).toContain('Sign in to book your call');expect(fetchMock).not.toHaveBeenCalled();
});
test("a saved reservation link reads owner-scoped status without repeating setup",async()=>{
  query=new URLSearchParams('reservation_id=reservation');await act(async()=>root.render(createElement(Page)));
  expect(fetchMock).toHaveBeenCalledWith('/api/scheduling/google/reservations/reservation',expect.anything());expect(container.textContent).toContain('Booking confirmed');
  expect(fetchMock.mock.calls.some(([url])=>url.includes('/book/'))).toBe(false);
});


test("canceling requires an explicit confirmation and remains pending until Google responds",async()=>{
  query=new URLSearchParams('reservation_id=reservation');await act(async()=>root.render(createElement(Page)));
  await click('Cancel booking');expect(fetchMock.mock.calls.some(([,init])=>init?.method==='DELETE')).toBe(false);
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({reservation:{id:'reservation',status:'canceling',revision:1,...slot}})});
  await click('Confirm cancellation');expect(container.textContent).toContain('Confirming cancellation');expect(container.textContent).not.toContain('Booking canceled');
  expect(JSON.parse(fetchMock.mock.calls.find(([,init])=>init?.method==='DELETE')![1].body)).toEqual({revision:0});
});
