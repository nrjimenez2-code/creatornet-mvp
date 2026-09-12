/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSearchResults } from "@/lib/useSearchResults";
import { EMPTY_SEARCH, type SearchResponse } from "@/lib/searchTypes";
jest.mock("@/lib/posthog",()=>({trackEvent:jest.fn()}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement;
let current:ReturnType<typeof useSearchResults>;
const request=jest.fn();
function Harness({query}:{query:string}) {current=useSearchResults(query);return createElement('p',null,JSON.stringify(current.result));}
const render=async(query:string)=>{await act(async()=>root.render(createElement(Harness,{query})));};
const advance=async()=>{await act(async()=>jest.advanceTimersByTime(300));};
const data=(id:string):SearchResponse=>({...EMPTY_SEARCH,items:[{id,caption:id,content:id,media_url:null,poster_url:null,creator_id:'creator',creator:{username:'luis'}}],totals:{creators:0,videos:1,offerings:0}});
const response=(value:SearchResponse)=>({ok:true,json:async()=>value});
beforeEach(()=>{jest.useFakeTimers();container=document.createElement('div');document.body.append(container);root=createRoot(container);request.mockReset();global.fetch=request;});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();jest.useRealTimers();});
test('late responses cannot overwrite the newest query even when fetch ignores abort',async()=>{
  let resolveFirst:(value:unknown)=>void=()=>{};
  request.mockImplementationOnce(()=>new Promise(resolve=>{resolveFirst=resolve;})).mockResolvedValueOnce(response(data('new')));
  await render('old');await advance();await render('new');await advance();
  expect(current.result.items[0].id).toBe('new');
  await act(async()=>resolveFirst(response(data('old'))));
  expect(current.result.items[0].id).toBe('new');
});
test('clearing removes results and cancels pending searches',async()=>{
  request.mockResolvedValue(response(data('old')));
  await render('old');await advance();expect(current.result.items).toHaveLength(1);
  await render('pending');await render('');await advance();
  expect(current.result.items).toEqual([]);expect(current.loading).toBe(false);expect(request).toHaveBeenCalledTimes(1);
});
test('rapid typing makes one request',async()=>{
  request.mockResolvedValue(response(data('final')));
  await render('e');await render('ec');await render('ecom');await advance();
  expect(request).toHaveBeenCalledTimes(1);
  expect(JSON.parse(request.mock.calls[0][1].body).q).toBe('ecom');
});
test('network failures stay distinct from no matches and can retry',async()=>{
  request.mockRejectedValueOnce(new Error('Connection failed')).mockResolvedValueOnce(response(EMPTY_SEARCH));
  await render('ecom');await advance();expect(current.error).toBe('Connection failed');
  await act(async()=>current.retry());await advance();expect(current.error).toBe('');expect(current.result.items).toEqual([]);
});
test('load more appends and a new query resets pagination',async()=>{
  request.mockResolvedValueOnce(response({...data('first'),totals:{creators:0,videos:2,offerings:0}})).mockResolvedValueOnce(response({...data('second'),page:1})).mockResolvedValueOnce(response(data('other')));
  await render('ecom');await advance();await act(async()=>current.loadMore());await advance();
  expect(current.result.items.map(p=>p.id)).toEqual(['first','second']);
  await render('yoga');await advance();expect(current.result.items.map(p=>p.id)).toEqual(['other']);
  expect(JSON.parse(request.mock.calls[2][1].body).page).toBe(0);
});
