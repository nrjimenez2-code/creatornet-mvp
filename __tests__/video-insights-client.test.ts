/** @jest-environment jsdom */
import { bindVideoInsights, leaveInsightVideo } from "@/lib/videoInsightsClient";
import { insightPlaybackSuspended, pauseForInsights } from "@/lib/insightPlayback";
let now=0;
let frameCallback:VideoFrameRequestCallback;
const mockFetch=jest.fn();
const post="post";
function video() {
  const result=document.createElement("video");result.src="/test.mp4";document.body.appendChild(result);
  Object.defineProperty(result,"paused",{configurable:true,value:false});Object.defineProperty(result,"readyState",{configurable:true,value:4});
  result.requestVideoFrameCallback=jest.fn(callback=>{frameCallback=callback;return 1;});result.cancelVideoFrameCallback=jest.fn();
  result.pause=jest.fn(()=>{Object.defineProperty(result,"paused",{configurable:true,value:true});result.dispatchEvent(new Event("pause"));});
  result.play=jest.fn(async()=>{Object.defineProperty(result,"paused",{configurable:true,value:false});result.dispatchEvent(new Event("play"));});
  return result;
}
const input=(eligible=()=>true)=>({postId:post,media:"/test.mp4",userId:null,token:null,source:"discover" as const,active:true,eligible});
const frame=(position:number)=>{now+=1000;frameCallback(now,{mediaTime:position} as VideoFrameCallbackMetadata);};
async function settle() {for(let i=0;i<24;i++)await Promise.resolve();}
beforeEach(()=>{
  jest.useFakeTimers();now=0;process.env.NEXT_PUBLIC_VIDEO_INSIGHTS_COLLECTION_ENABLED="true";
  Object.defineProperty(document,"hidden",{configurable:true,value:false});
  Object.defineProperty(globalThis.crypto,"randomUUID",{configurable:true,value:jest.fn(()=>"33333333-3333-4333-8333-333333333333")});
  mockFetch.mockReset().mockImplementation(async(path:string,options:{body:string})=>({ok:true,json:async()=>path.endsWith("sessions")?{sessionId:JSON.parse(options.body).sessionId,duration:10}:{ok:true}}));
  global.fetch=mockFetch;
});
afterEach(async()=>{leaveInsightVideo(post);await settle();jest.runOnlyPendingTimers();jest.useRealTimers();document.body.innerHTML="";delete process.env.NEXT_PUBLIC_VIDEO_INSIGHTS_COLLECTION_ENABLED;});
test("starts on an advancing frame, ignores inactive/preload samples, flushes immediate departure",async()=>{
  const v=video();let active=false;const off=bindVideoInsights(v,input(()=>active));frame(0);frame(1);await settle();expect(mockFetch).not.toHaveBeenCalled();
  active=true;frame(2);frame(3);off();await settle();
  expect(mockFetch.mock.calls.filter(call=>call[0].endsWith("sessions"))).toHaveLength(1);
  expect(JSON.parse(mockFetch.mock.calls.find(call=>call[0].endsWith("events"))![1].body)).toMatchObject({seconds:1,intervals:[[2,3]]});
});
test("remount, seek, pause and player handoff retain the same session; return creates another",async()=>{
  const v=video();const detach=bindVideoInsights(v,input());frame(0);frame(1);await settle();detach();
  const next=video();const off=bindVideoInsights(next,input());frame(1);frame(2);next.dispatchEvent(new Event("seeking"));frame(8);frame(9);next.pause();await settle();
  const starts=()=>mockFetch.mock.calls.filter(call=>call[0].endsWith("sessions"));expect(starts()).toHaveLength(1);
  leaveInsightVideo(post);off();await settle();const third=video();const end=bindVideoInsights(third,input());frame(0);frame(1);await settle();expect(starts()).toHaveLength(2);end();
});
test("hidden tabs, stalls and suspended insight playback cannot credit movement",async()=>{
  const v=video();const off=bindVideoInsights(v,input());frame(0);frame(1);await settle();
  v.dispatchEvent(new Event("waiting"));frame(2);frame(3);v.dispatchEvent(new Event("playing"));frame(3);frame(4);
  Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"));frame(5);
  Object.defineProperty(document,"hidden",{configurable:true,value:false});frame(5);frame(6);v.pause();await settle();
  const events=mockFetch.mock.calls.filter(call=>call[0].endsWith("events"));expect(JSON.parse(events.at(-1)![1].body).seconds).toBe(3);off();
});
test("insights suspend attempts to autoplay and resume only an unchanged active player",async()=>{
  const v=video();const restore=pauseForInsights(v,()=>true);expect(insightPlaybackSuspended(v)).toBe(true);expect(v.pause).toHaveBeenCalled();
  await v.play();expect(v.paused).toBe(true);restore();expect(insightPlaybackSuspended(v)).toBe(false);expect(v.play).toHaveBeenCalledTimes(2);
  const stale=pauseForInsights(v,()=>true);v.src="/other.mp4";stale();expect(v.play).toHaveBeenCalledTimes(2);
});
test("collection defaults off without attaching any frame observers",()=>{
  delete process.env.NEXT_PUBLIC_VIDEO_INSIGHTS_COLLECTION_ENABLED;const v=video();bindVideoInsights(v,input());expect(v.requestVideoFrameCallback).not.toHaveBeenCalled();
});
