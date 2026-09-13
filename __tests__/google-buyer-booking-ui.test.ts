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


test("rescheduling keeps the confirmed time visible while a new time is pending",async()=>{
  query=new URLSearchParams('reservation_id=reservation');await act(async()=>root.render(createElement(Page)));
  const next={start:'2026-10-01T11:00:00Z',end:'2026-10-01T11:30:00Z'};
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({revision:0,slots:[next]})});
  await click('Reschedule booking');
  await act(async()=>{(container.querySelector('input[name=new-time]') as HTMLInputElement).click();});
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({reservation:{id:'reservation',status:'rescheduling',revision:1,...slot,desiredStart:next.start,desiredEnd:next.end}})});
  await click('Request new time');
  expect(container.textContent).toContain('Confirming your new time');expect(container.textContent).toContain('Current time:');expect(container.textContent).toContain('Requested new time:');
  const sent=fetchMock.mock.calls.find(([url,init])=>url.endsWith('/times')&&init?.method==='POST');expect(JSON.parse(sent![1].body)).toEqual({...next,revision:0});
});
test("stale reschedule options cannot be submitted",async()=>{
  query=new URLSearchParams('reservation_id=reservation');await act(async()=>root.render(createElement(Page)));
  fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({revision:1,slots:[slot]})});await click('Reschedule booking');
  expect(container.querySelector('[role=alert]')?.textContent).toContain('booking changed');
  expect(container.querySelector('input[name=new-time]')).toBeNull();
});

test("recovered external changes show the actual booking and allow another reschedule",async()=>{
 query=new URLSearchParams('reservation_id=reservation');
 fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({reservation:{id:'reservation',status:'confirmed',revision:1,...slot,recoveryCode:'google_booking_changed_externally'}})});
 await act(async()=>root.render(createElement(Page)));
 expect(container.textContent).toContain('changed in Google Calendar before your reschedule finished');
 expect(container.textContent).toContain('Booking confirmed');
 expect(Array.from(container.querySelectorAll('button')).some(button=>button.textContent==='Reschedule booking')).toBe(true);
 expect(container.textContent).not.toContain('Confirming your new time');
});

test("an unattempted failed booking can choose again from its saved reservation link",async()=>{
 query=new URLSearchParams('reservation_id=reservation');
 const failed={id:'reservation',status:'failed',revision:0,...slot,recoveryCode:'google_booking_time_unavailable'};
 fetchMock.mockImplementation(async(url:string,init?:RequestInit)=>({ok:true,json:async()=>url.includes('/reservations/')?{reservation:failed}:init?.method==='POST'?{reservation:{...failed,status:'creating',revision:1,recoveryCode:null}}:{title:'Call',durationMinutes:30,timeZone:'UTC',slots:[slot],reservation:failed}}));
 await act(async()=>root.render(createElement(Page)));
 expect(container.textContent).toContain('No event was created in Google Calendar');
 expect(fetchMock.mock.calls.some(([url])=>url.includes('/book/')&&url.includes('reservation_id=reservation'))).toBe(true);
 await act(async()=>{(container.querySelector('input[type=radio]') as HTMLInputElement).click();});await click('Book this time');
 const body=JSON.parse(fetchMock.mock.calls.find(([,init])=>init?.method==='POST')![1].body);
 expect(body.reservationId).toBe('reservation');expect(container.textContent).toContain('Confirming with Google Calendar');
});


test("a failed unattempted reschedule clearly retains the original booking",async()=>{
 query=new URLSearchParams('reservation_id=reservation');
 fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({reservation:{id:'reservation',status:'confirmed',revision:1,...slot,recoveryCode:'google_booking_time_unavailable'}})});
 await act(async()=>root.render(createElement(Page)));
 expect(container.textContent).toContain('Your original booking is unchanged');expect(container.textContent).toContain('Booking confirmed');
 expect(container.textContent).not.toContain('No event was created');expect(container.textContent).not.toContain('Requested new time:');
});
