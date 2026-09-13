/** @jest-environment jsdom */
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
let userId="creator";
jest.mock("@/lib/useUser",()=>({useUser:()=>({userId,session:{access_token:"token"},loading:false})}));
import GoogleCalendarSetupPage from "@/app/scheduling/google/page";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const originalFetch=global.fetch;
const fetchMock=jest.fn();let root:Root;let container:HTMLDivElement;
beforeEach(()=>{
  userId="creator";fetchMock.mockReset().mockImplementation(async(_url,init)=>({ok:true,json:async()=>init?.method==='POST'?{ok:true}:{accountName:'creator@example.test',calendars:[{id:'owned',summary:'Work',timeZone:'America/Phoenix',primary:true}],settings:null}}));
  global.fetch=fetchMock;container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();global.fetch=originalFetch;});
test("creator reviews owned calendar and weekly hours before submitting setup",async()=>{
  await act(async()=>root.render(createElement(GoogleCalendarSetupPage)));
  expect(container.textContent).toContain('creator@example.test');expect(container.querySelector('select')?.value).toBe('owned');
  expect(container.querySelectorAll('input[type=time]')).toHaveLength(10);
  expect(fetchMock.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);
  await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  const saved=fetchMock.mock.calls.find(([,init])=>init?.method==='POST')!;
  expect(JSON.parse(saved[1].body)).toMatchObject({calendarId:'owned',conflictCalendarIds:['owned'],availability:{timeZone:'America/Phoenix',durationMinutes:30,windows:expect.any(Array)}});
  expect(container.textContent).toContain('Google Calendar connected');
});
test("switching accounts clears the prior account's calendar settings immediately",async()=>{
  await act(async()=>root.render(createElement(GoogleCalendarSetupPage)));
  fetchMock.mockImplementation(()=>new Promise(()=>{}));userId='another';
  await act(async()=>root.render(createElement(GoogleCalendarSetupPage)));
  expect(container.textContent).not.toContain('creator@example.test');expect(container.querySelector('form')).toBeNull();
});
