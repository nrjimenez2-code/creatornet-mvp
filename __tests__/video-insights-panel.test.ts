/** @jest-environment jsdom */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
const mockSession=jest.fn(),mockFetch=jest.fn();
let mockUser:string|null="owner";
jest.mock("@/lib/actionSession",()=>({getActionSession:()=>mockSession()}));
jest.mock("@/lib/useUser",()=>({useUser:()=>({userId:mockUser,loading:false})}));
jest.mock("next/dynamic",()=>({__esModule:true,default:()=>()=>createElement("div",null,"Lazy insights panel")}));
jest.mock("recharts",()=>{
  const Container=({children}:{children?:ReactNode})=>createElement("div",null,children);
  return {ResponsiveContainer:Container,LineChart:Container,Line:()=>null,XAxis:()=>null,YAxis:()=>null,CartesianGrid:()=>null,ReferenceLine:()=>null};
});
import VideoInsightsPanel from "@/components/VideoInsightsPanel";
import DeleteVideoButton from "@/components/DeleteVideoButton";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement;
const fixture={postId:"post",title:"Test video",poster:null,previewUrl:"/test.mp4",duration:10,sampleCount:2,limited:true,
  collectionStartedAt:"2026-09-27T00:00:00Z",averageWatchTime:4.5,averagePercentageWatched:45,completionRate:50,threeSecondRetention:50,
  retention:[{time:0,percentage:100},{time:1,percentage:50},{time:2,percentage:75}],sources:[{source:"discover",percentage:50,count:1},{source:"unknown",percentage:50,count:1}]};
beforeEach(()=>{
  process.env.NEXT_PUBLIC_VIDEO_INSIGHTS_UI_ENABLED="true";mockUser="owner";
  mockSession.mockReset().mockResolvedValue({data:{session:{access_token:"test-token"}},error:null});
  mockFetch.mockReset().mockResolvedValue({ok:true,json:async()=>fixture});global.fetch=mockFetch;
  if(!AbortSignal.timeout)AbortSignal.timeout=()=>new AbortController().signal;
  if(!AbortSignal.any)AbortSignal.any=signals=>signals[0];
  HTMLMediaElement.prototype.pause=jest.fn();
  HTMLMediaElement.prototype.play=jest.fn(async()=>{});
  HTMLDialogElement.prototype.showModal=function(){this.open=true;this.querySelector<HTMLButtonElement>("[autofocus]")?.focus();};
  HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new Event("close"));};
  container=document.createElement("div");document.body.appendChild(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();document.body.innerHTML="";delete process.env.NEXT_PUBLIC_VIDEO_INSIGHTS_UI_ENABLED;});
async function renderPanel(){await act(async()=>root.render(createElement(VideoInsightsPanel,{postId:"post"})));}
async function click(label:string){await act(async()=>[...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===label||b.getAttribute("aria-label")===label)!.click());}
test("exact metrics, limited data, sources, chart selection and excluded paused preview are shown",async()=>{
  await renderPanel();expect(container.textContent).toContain("Limited data");expect(container.textContent).toContain("Unknown");
  expect(container.textContent).toContain("45.0%");expect(container.textContent).toContain("2 video plays");
  expect(container.querySelector("dl")?.textContent).toContain("Video plays");
  const sections=[...container.querySelectorAll("details")];
  expect(sections.map(section=>section.querySelector("summary")?.firstElementChild?.textContent)).toEqual(["More playback metrics","View sources","About these numbers"]);
  expect(sections.map(section=>section.open)).toEqual([false,false,false]);
  await act(async()=>sections[0].querySelector("summary")!.click());
  expect(sections[0].open).toBe(true);
  const slider=container.querySelector<HTMLInputElement>('input[type="range"]')!;
  const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!;
  await act(async()=>{set.call(slider,"2");slider.dispatchEvent(new Event("input",{bubbles:true}));});
  expect(sections[0].open).toBe(true);
  const preview=container.querySelector<HTMLVideoElement>("video")!;
  expect(preview.currentTime).toBe(2);expect(preview.dataset.insightsPreview).toBe("true");expect(preview.autoplay).toBe(false);
  expect(slider.getAttribute("aria-valuetext")).toBe("0:02, 75.0 percent");
  await act(async()=>preview.dispatchEvent(new Event("play")));expect(preview.pause).toHaveBeenCalled();
});
test("failed request is retryable and successful retry replaces error",async()=>{
  mockFetch.mockResolvedValueOnce({ok:false,json:async()=>({error:"Please retry."})});await renderPanel();expect(container.textContent).toContain("Please retry.");
  await click("Try again");expect(container.textContent).toContain("Test video");expect(mockFetch).toHaveBeenCalledTimes(2);
});
test("no-data and unavailable-duration states are explicit",async()=>{
  mockFetch.mockResolvedValueOnce({ok:true,json:async()=>({...fixture,sampleCount:0,retention:[]})});await renderPanel();expect(container.textContent).toContain("No playback data yet");
  await act(async()=>root.unmount());root=createRoot(container);
  mockFetch.mockResolvedValueOnce({ok:true,json:async()=>({...fixture,duration:null,retention:[],completionRate:null,averagePercentageWatched:null,threeSecondRetention:null})});
  await renderPanel();expect(container.textContent).toContain("Verified video duration is unavailable");expect(container.querySelector('input[type="range"]')).toBeNull();
});
test("owner insights appears above delete, lazy panel mounts only when opened and focus returns",async()=>{
  await act(async()=>root.render(createElement(DeleteVideoButton,{postId:"post",creatorId:"owner",onDeleted:()=>{}})));
  expect(document.body.textContent).not.toContain("Lazy insights panel");await click("Video options");
  const menu=document.querySelector<HTMLDialogElement>('dialog[aria-label="Video options"]')!;
  expect([...menu.querySelectorAll("button")].slice(0,2).map(b=>b.textContent)).toEqual(["View insights","Delete video"]);
  await click("View insights");expect(document.querySelector<HTMLDialogElement>('dialog[aria-labelledby="insights-title-post"]')!.open).toBe(true);
  expect(document.body.textContent).toContain("Lazy insights panel");await click("Close video insights");expect(document.activeElement?.getAttribute("aria-label")).toBe("Video options");
});
test("non-owner never gets insight action and off flag preserves owner menu",async()=>{
  mockUser="viewer";await act(async()=>root.render(createElement(DeleteVideoButton,{postId:"post",creatorId:"owner",onDeleted:()=>{}})));
  await click("Video options");expect(document.body.textContent).not.toContain("View insights");
  mockUser="owner";delete process.env.NEXT_PUBLIC_VIDEO_INSIGHTS_UI_ENABLED;
  await act(async()=>root.render(createElement(DeleteVideoButton,{postId:"post",creatorId:"owner",onDeleted:()=>{}})));
  expect(document.body.textContent).not.toContain("View insights");expect(document.body.textContent).toContain("Delete video");
});
