/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
jest.mock("next/navigation", () => ({ useRouter: () => ({push:jest.fn(),refresh:jest.fn()}) }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({userId:null,loading:false}) }));
jest.mock("@/lib/posthog", () => ({ normalizeCategory: (value:unknown) => value }));
jest.mock("@/components/VideoCard", () => ({ __esModule:true,default:({postId,tipsEnabled}:{postId:string;tipsEnabled?:boolean}) => createElement("div",{"data-playing-post":postId,"data-tips-enabled":String(tipsEnabled === true)}) }));
import ProfileContent from "@/components/ProfileContent";
import { buildOffers } from "@/lib/offers";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let host: HTMLDivElement,root:Root;
beforeEach(() => {
  host=document.createElement("div");document.body.appendChild(host);root=createRoot(host);
  Object.defineProperty(globalThis,"IntersectionObserver",{configurable:true,value:class {observe(){} disconnect(){}}});
  Element.prototype.scrollIntoView=jest.fn(); window.scrollTo=jest.fn();
  global.fetch=jest.fn();
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const posts=(count:number)=>Array.from({length:count},(_,i)=>({id:`p${i}`,title:`Post ${i}`,creator_id:"creator",video_url:`video${i}.mp4`,poster_url:i%2?"poster.jpg":null,view_count:i?1395:0,product_id:"product"}));
async function render(count=3,errors:Record<string,boolean>={},withOffers=false) {
  await act(async()=>root.render(createElement(ProfileContent,{
    gallery:{posts:posts(count),creatorId:"creator",creatorName:"Creator"},
    offers:{creatorId:"creator",creatorName:"Creator",offers:withOffers?buildOffers([{id:"product",title:"Course",type:"course",amount_cents:9700}],posts(count)):[],sellReady:false,rating:null},...errors,
  })));
}
test.each([0,1,2,3,12])("%i posts retain both tabs and equal-column media tiles",async count=>{
  await render(count);
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
  const panel=host.querySelector('[role="tabpanel"]')!;
  expect(panel.querySelectorAll('button[aria-label^="Open post"]')).toHaveLength(count);
  if(count){
    expect(panel.querySelector('.grid')?.className).toContain("grid-cols-3 gap-px lg:grid-cols-4");
    const tile=panel.querySelector('button')!;
    expect(tile.className).toContain("aspect-[9/16]");expect(tile.className).not.toContain("border ");
    expect(host.querySelectorAll('[data-video-view-count]')).toHaveLength(count);
    expect(host.querySelector(`#${tile.getAttribute("aria-describedby")}`)?.textContent).toBe("0 views");
  }else expect(panel.textContent).toContain("No posts yet");
  await act(async()=>host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click());
  expect(host.querySelectorAll('[role="tabpanel"]')[1].textContent).toContain("No offers yet");
});
test("keyboard tabs have linked panels, active underline, and distinct errors",async()=>{
  await render(0,{postsError:true,offersError:true});
  const tabs=host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  expect(host.textContent).not.toContain("No posts yet");expect(host.textContent).not.toContain("No offers yet");
  await act(async()=>tabs[0].dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true})));
  expect(tabs[1].getAttribute("aria-selected")).toBe("true");expect(tabs[1].className).toContain("border-white");
  expect(document.activeElement).toBe(tabs[1]);
  const panel=document.getElementById(tabs[1].getAttribute("aria-controls")!)!;
  expect(panel.hidden).toBe(false);expect(panel.querySelector('[role="alert"]')?.textContent).toContain("load offers");
  await act(async()=>tabs[1].dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true})));
  expect(document.activeElement).toBe(tabs[0]);
});
test("offers stay inline with prices and readiness gates, while tab/preview interactions never record views",async()=>{
  await render(3,{},true);
  await act(async()=>host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const panel=host.querySelectorAll('[role="tabpanel"]')[1];
  expect(panel.textContent).toContain("$97");expect(panel.querySelector<HTMLButtonElement>('li button')?.disabled).toBe(true);
  // The newest post has no poster; its product fallback is not a published-video preview.
  expect(panel.querySelector('[data-video-view-count]')).toBeNull();
  await act(async()=>host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[0].click());
  const tiles=host.querySelectorAll<HTMLButtonElement>('button[aria-label^="Open post"]');
  tiles[0].querySelector('video')?.dispatchEvent(new Event("loadedmetadata"));
  host.querySelector('.grid')?.dispatchEvent(new Event("scroll"));
  await act(async()=>tiles[2].click());
  expect(host.querySelector('[data-playing-post="p2"]')).not.toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
});

test.each([
  [true, true, true],
  [true, false, true],
  [false, true, false],
])("profile tabs preserve tipping availability=%s and owner=%s", async (tippingAvailable, viewerIsOwner, expectedTips) => {
  await act(async () => root.render(createElement(ProfileContent, {
    gallery: {
      posts: posts(1).map(post => ({...post, tips_enabled: true})),
      creatorId: "creator", creatorName: "Creator", tippingAvailable, viewerIsOwner,
    },
    offers: {creatorId: "creator", creatorName: "Creator", offers: [], sellReady: false, rating: null},
  })));
  expect(host.querySelector('#profile-views-p0')?.textContent).toBe("0 views");
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label^="Open post"]')!.click());
  expect(host.querySelector('[data-playing-post="p0"]')?.getAttribute("data-tips-enabled")).toBe(String(expectedTips));
  const toggle = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === "Disable tips");
  expect(toggle).toBeUndefined();
  expect(global.fetch).not.toHaveBeenCalled();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true})));
  await act(async () => host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click());
  await act(async () => host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[0].click());
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label^="Open post"]')!.click());
  expect(host.querySelector('[data-playing-post="p0"]')?.getAttribute("data-tips-enabled")).toBe(String(expectedTips));
  expect(global.fetch).not.toHaveBeenCalled();
});
