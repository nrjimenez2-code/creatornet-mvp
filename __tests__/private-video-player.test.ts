/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import PrivateVideoPlayer from "@/components/PrivateVideoPlayer";

const originalFetch=globalThis.fetch;
let container:HTMLDivElement,root:Root,video:HTMLVideoElement,paused:boolean;
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const receipt=(version:number)=>({ok:true,status:200,json:async()=>({url:"https://private.invalid/signed-"+version+".mp4",expires_at:new Date(Date.now()+120000).toISOString()})});
beforeEach(async()=>{
 jest.useFakeTimers();paused=true;
 jest.spyOn(HTMLMediaElement.prototype,"load").mockImplementation(()=>{});
 jest.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(()=>{paused=true;});
 jest.spyOn(HTMLMediaElement.prototype,"play").mockImplementation(async()=>{paused=false;});
 globalThis.fetch=jest.fn(async()=>receipt(1)) as unknown as typeof fetch;
 container=document.createElement("div");document.body.append(container);root=createRoot(container);
 await act(async()=>root.render(createElement(PrivateVideoPlayer,{assetId:"asset",purchaseId:"purchase",position:300})));
 video=container.querySelector("video")!;
 Object.defineProperties(video,{duration:{configurable:true,value:7200},paused:{configurable:true,get:()=>paused},readyState:{configurable:true,value:1}});
 await act(async()=>video.dispatchEvent(new Event("loadedmetadata")));
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();globalThis.fetch=originalFetch;jest.restoreAllMocks();jest.useRealTimers();});

test("renewal waits for fresh entitlement then preserves the latest time, playing state and speed",async()=>{
 expect(video.currentTime).toBe(300);
 let resolveToken:(value:ReturnType<typeof receipt>)=>void=()=>{};
 (fetch as jest.Mock).mockImplementation((url:string)=>url.includes("/playback")?new Promise(resolve=>{resolveToken=resolve;}):Promise.resolve({ok:true}));
 paused=false;video.currentTime=350;video.playbackRate=1.5;
 await act(async()=>video.dispatchEvent(new Event("timeupdate")));
 await act(async()=>jest.advanceTimersByTime(60000));
 video.currentTime=362;
 await act(async()=>video.dispatchEvent(new Event("timeupdate")));
 await act(async()=>resolveToken(receipt(2)));
 await act(async()=>video.dispatchEvent(new Event("loadedmetadata")));
 expect(video.src).toBe("https://private.invalid/signed-2.mp4");
 expect(video.currentTime).toBe(362);expect(video.playbackRate).toBe(1.5);expect(paused).toBe(false);
 expect(fetch).toHaveBeenCalledWith("/api/private-videos/asset/playback?purchase_id=purchase",expect.objectContaining({credentials:"include",cache:"no-store"}));
});
test("revocation at renewal removes the prior URL and stops playback",async()=>{
 (fetch as jest.Mock).mockImplementation(async(url:string)=>url.includes("/playback")?{ok:false,status:403,json:async()=>({error:"No current purchased access."})}:{ok:true});
 paused=false;video.currentTime=400;
 await act(async()=>video.dispatchEvent(new Event("play")));
 await act(async()=>jest.advanceTimersByTime(60000));
 expect(paused).toBe(true);expect(video.getAttribute("src")).toBeNull();
 expect(container.textContent).toContain("No current purchased access.");
});
