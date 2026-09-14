/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
let userId='buyer';jest.mock("@/lib/useUser",()=>({useUser:()=>({userId,session:{access_token:'token'}})}));
import GoogleBookingsList from "@/components/GoogleBookingsList";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const originalFetch=global.fetch,fetchMock=jest.fn();let root:Root,container:HTMLDivElement;
beforeEach(()=>{userId='buyer';fetchMock.mockReset().mockImplementation(async()=>({ok:true,json:async()=>({bookings:[{id:'booking',connection_id:'calendar',title:'Consultation',counterparty_name:'Person',status:'rescheduling',starts_at:'2026-10-01T10:00:00Z',desired_starts_at:'2026-10-01T11:00:00Z'}],next:null})}));global.fetch=fetchMock;container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();global.fetch=originalFetch;});
test.each([null,{}, {bookings:null}, {bookings:{}}])("malformed booking responses show a recoverable error: %j",async(body)=>{
 fetchMock.mockResolvedValueOnce({ok:true,json:async()=>body});
 await act(async()=>root.render(createElement(GoogleBookingsList)));
 expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not load bookings. Try again.');
 expect(container.textContent).not.toContain('No Google Calendar bookings yet.');
 await act(async()=>Array.from(container.querySelectorAll('button')).find(button=>button.textContent==='Refresh bookings')!.click());
 expect(container.querySelector('[role="alert"]')).toBeNull();
 expect(container.textContent).toContain('Consultation');
});
test("buyer bookings link to owner-scoped management while incoming calls use the creator view",async()=>{
 await act(async()=>root.render(createElement(GoogleBookingsList)));
 expect(container.querySelector('a')?.getAttribute('href')).toBe('/scheduling/book/calendar?reservation_id=booking');expect(container.textContent).toContain('Requested new time:');
 await act(async()=>{const select=container.querySelector('select')!;select.value='creator';select.dispatchEvent(new Event('change',{bubbles:true}));});
 expect(fetchMock.mock.calls.at(-1)[0]).toContain('role=creator');expect(container.textContent).toContain('Booked by Person');expect(container.querySelector('a')?.textContent).toBe('Open Google Calendar');
});
test("account changes remove the previous account's bookings before the next response",async()=>{
 await act(async()=>root.render(createElement(GoogleBookingsList)));userId='other';fetchMock.mockImplementation(()=>new Promise(()=>{}));
 await act(async()=>root.render(createElement(GoogleBookingsList)));expect(container.textContent).not.toContain('Person');
});

test("failed bookings retain their buyer recovery link and do not appear confirmed",async()=>{
 fetchMock.mockResolvedValueOnce({ok:true,json:async()=>({bookings:[{id:'booking',connection_id:'calendar',title:'Call',counterparty_name:'Person',status:'failed',starts_at:'2026-10-01T10:00:00Z'}],next:null})});
 await act(async()=>root.render(createElement(GoogleBookingsList)));
 expect(container.textContent).toContain('Not booked');expect(container.textContent).toContain('Previous requested time:');
 expect(container.querySelector('a')?.getAttribute('href')).toBe('/scheduling/book/calendar?reservation_id=booking');
});
