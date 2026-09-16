/** @jest-environment jsdom */
import { act, createElement, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PostRow } from "@/lib/feedV3";

type RealtimePayload = { eventType: "INSERT" | "UPDATE" | "DELETE"; new: Record<string, unknown>; old: Record<string, unknown> };
const handlers: ((payload: RealtimePayload) => void)[] = [];
const channel = {
  on: (_event: string, _filter: unknown, callback: typeof handlers[number]) => { handlers.push(callback); return channel; },
  subscribe: () => channel,
};
const client = { channel: () => channel, removeChannel: jest.fn() };
const pageFetch = jest.fn();
const offerLoad = jest.fn();
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => client }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({userId:"viewer",loading:false}) }));
jest.mock("@/lib/posthog", () => ({ trackEvent: jest.fn(), normalizeCategory: (value: string) => value }));
jest.mock("@/lib/browserVisibility", () => ({ useDesktopViewport: () => true, usePageVisible: () => true }));
jest.mock("@/lib/discoverClient", () => ({fetchDiscoverPage:(...args:unknown[])=>pageFetch(...args),rememberDiscoverSession:jest.fn()}));
jest.mock("@/lib/feedOffers", () => ({loadFeedOffers:(...args:unknown[])=>offerLoad(...args)}));
jest.mock("@/components/VideoCard", () => ({
  __esModule:true,
  default: (props: {postId:string;productId:string;purchaseOptionsReady:boolean;isActive:boolean}) => createElement("video", {
    "data-card":props.postId,"data-product":props.productId,"data-ready":String(props.purchaseOptionsReady),"data-active":String(props.isActive),
  }),
}));
import FeedList from "@/components/FeedList";

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
class Observer { observe() {} unobserve() {} disconnect() {} }
globalThis.IntersectionObserver=Observer as unknown as typeof IntersectionObserver;
let container:HTMLDivElement,root:Root;
const commits=jest.fn();
const row=(id:string)=>({post_id:id,creator_id:"creator",product_id:"alias-"+id,video_url:"https://example.test/video.mp4",title:id});
const page=(id:string)=>({items:[row(id)],session:id+"-session",nextOffset:1,hasMore:false});
const offer=(post:PostRow,productId=post.product_id)=>({...post,product_id:productId,monthlyTerms:null,purchaseOptionsReady:true});
function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(finish=>{resolve=finish;});
  return {promise,resolve};
}
const currentHandler=()=>handlers[handlers.length-1];
const refreshButton=()=>Array.from(container.querySelectorAll("button")).find(button=>button.textContent==="New posts · Refresh");
const publish=(id:string):RealtimePayload=>({eventType:"INSERT",new:{id,video_url:"https://example.test/new.mp4"},old:{}});
beforeEach(()=>{
  jest.useFakeTimers();
  handlers.length=0;
  pageFetch.mockReset().mockResolvedValue(page("visible"));
  offerLoad.mockReset().mockImplementation(async(posts:PostRow[])=>posts.map(post=>offer(post)));
  commits.mockReset();
  container=document.createElement("div");document.body.appendChild(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();jest.restoreAllMocks();jest.useRealTimers();});
async function render() {
  await act(async()=>root.render(createElement(Profiler,{id:"feed",onRender:commits},
    createElement(FeedList,{activeTab:"discover",onChangeTab:jest.fn()}))));
}

test("thousands of new-post notifications leave playback stable and refresh only when the viewer asks",async()=>{
  await render();
  const playing=container.querySelector('video[data-active="true"]');
  await act(async()=>currentHandler()(publish("first-new")));
  expect(refreshButton()).toBeDefined();
  const before=commits.mock.calls.length;
  for(let batch=0;batch<20;batch++) {
    await act(async()=>{
      for(let index=0;index<100;index++) {
        currentHandler()(publish(`new-${batch}-${index}`));
        currentHandler()(publish("first-new"));
      }
    });
  }
  // An already-visible refresh signal must not repaint the feed for each burst.
  expect(commits.mock.calls.length-before).toBeLessThanOrEqual(1);
  expect(container.querySelector('video[data-active="true"]')).toBe(playing);
  expect(container.querySelectorAll("section[data-post-id]")).toHaveLength(1);
  expect(pageFetch).toHaveBeenCalledTimes(1);
  expect(offerLoad).toHaveBeenCalledTimes(1);
  const refreshed=deferred<ReturnType<typeof page>>();
  pageFetch.mockReturnValueOnce(refreshed.promise);
  const oldHandler=currentHandler();
  await act(async()=>refreshButton()!.click());
  expect(pageFetch.mock.calls[1].slice(0,4)).toEqual(["discover",0,20,null]);
  expect(container.textContent).toContain("Loading");
  await act(async()=>currentHandler()({eventType:"UPDATE",new:{id:"visible",video_url:"https://example.test/video.mp4"},old:{}}));
  expect(offerLoad).toHaveBeenCalledTimes(1);
  await act(async()=>refreshed.resolve(page("ranked-new")));
  expect(container.querySelector('[data-post-id="visible"]')).toBeNull();
  expect(container.querySelector('video[data-card="ranked-new"][data-active="true"]')).not.toBeNull();
  expect(refreshButton()).toBeUndefined();
  await act(async()=>oldHandler(publish("late-from-old-channel")));
  expect(refreshButton()).toBeUndefined();
  await act(async()=>currentHandler()(publish("next-new")));
  expect(refreshButton()).toBeDefined();
});

test("unrelated updates and deletions do no feed rendering or offer work, while a visible offer still refreshes",async()=>{
  await render();
  const playing=container.querySelector('video[data-active="true"]');
  const before=commits.mock.calls.length;
  for(let batch=0;batch<20;batch++) {
    await act(async()=>{
      for(let index=0;index<100;index++) {
        const id=`off-feed-${batch}-${index}`;
        currentHandler()({eventType:"UPDATE",new:{id,video_url:"https://example.test/other.mp4"},old:{}});
        currentHandler()({eventType:"UPDATE",new:{id},old:{}});
        currentHandler()({eventType:"DELETE",new:{},old:{id}});
      }
    });
  }
  expect(commits.mock.calls.length).toBe(before);
  expect(container.querySelector('video[data-active="true"]')).toBe(playing);
  expect(refreshButton()).toBeUndefined();
  expect(pageFetch).toHaveBeenCalledTimes(1);
  expect(offerLoad).toHaveBeenCalledTimes(1);
  const updated=deferred<PostRow[]>();
  offerLoad.mockReturnValueOnce(updated.promise);
  await act(async()=>currentHandler()({eventType:"UPDATE",new:{id:"visible",video_url:"https://example.test/video.mp4",product_id:"updated-alias"},old:{}}));
  await act(async()=>jest.advanceTimersByTime(25));
  expect(offerLoad).toHaveBeenCalledTimes(2);
  expect(container.querySelector('video[data-card="visible"]')?.getAttribute("data-ready")).toBe("false");
  const source=offerLoad.mock.calls[1][0][0] as PostRow;
  await act(async()=>updated.resolve([offer(source,"updated-product")]));
  expect(container.querySelector('video[data-card="visible"]')?.getAttribute("data-product")).toBe("updated-product");
  expect(container.querySelector('video[data-card="visible"]')?.getAttribute("data-ready")).toBe("true");
});

test("removing a visible post invalidates its outstanding offer response and repeated removals stay idle",async()=>{
  await render();
  const updated=deferred<PostRow[]>();
  offerLoad.mockReturnValueOnce(updated.promise);
  await act(async()=>currentHandler()({eventType:"UPDATE",new:{id:"visible",video_url:"https://example.test/video.mp4"},old:{}}));
  await act(async()=>jest.advanceTimersByTime(25));
  const source=offerLoad.mock.calls[1][0][0] as PostRow;
  await act(async()=>currentHandler()({eventType:"DELETE",new:{},old:{id:"visible"}}));
  expect(container.querySelector("video")).toBeNull();
  const before=commits.mock.calls.length;
  await act(async()=>updated.resolve([offer(source,"stale-product")]));
  await act(async()=>{
    for(let index=0;index<500;index++) currentHandler()({eventType:"DELETE",new:{},old:{id:"visible"}});
  });
  expect(commits.mock.calls.length).toBe(before);
  expect(container.querySelector("video")).toBeNull();
  expect(offerLoad).toHaveBeenCalledTimes(2);
});
