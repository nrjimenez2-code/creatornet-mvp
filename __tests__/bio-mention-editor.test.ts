/** @jest-environment jsdom */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import BioMentionEditor from '@/components/BioMentionEditor';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const mockFetch=jest.fn();
const accounts=[{id:'1',username:'Noah.Coach',full_name:'Noah',avatar_url:null},{id:'2',username:'no_ah',full_name:null,avatar_url:null}];
let root:Root;let container:HTMLDivElement;
function Wrapper(){const [value,setValue]=useState('');return createElement(BioMentionEditor,{value,onChange:setValue,disabled:false});}
beforeEach(()=>{jest.useFakeTimers();global.fetch=mockFetch;mockFetch.mockReset().mockResolvedValue({ok:true,json:async()=>({accounts})});global.requestAnimationFrame=callback=>setTimeout(()=>callback(0),0) as unknown as number;container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();jest.useRealTimers();});
const render=()=>act(async()=>root.render(createElement(Wrapper)));
async function type(value:string,cursor=value.length){
 const input=container.querySelector('textarea')!;
 await act(async()=>{input.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,value);input.setSelectionRange(cursor,cursor);input.dispatchEvent(new Event('input',{bubbles:true}));});
}
const advance=(ms=250)=>act(async()=>jest.advanceTimersByTime(ms));
const key=(value:string)=>act(async()=>container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true})));
test('debounces after one character and Escape dismisses suggestions',async()=>{
 await render();await type('@');await advance();expect(mockFetch).not.toHaveBeenCalled();
 await type('@no.');await advance(249);expect(mockFetch).not.toHaveBeenCalled();await advance(1);
 expect(mockFetch).toHaveBeenCalledWith('/api/profile/mention-suggestions?q=no.',expect.objectContaining({signal:expect.anything()}));
 expect(container.querySelectorAll('[role=option]')).toHaveLength(2);await key('Escape');expect(container.querySelector('[role=listbox]')).toBeNull();
});
test('keyboard selection replaces only the active token and restores focus and cursor',async()=>{
 await render();await type('First @no.thing and @other',9);await advance();await key('ArrowDown');
 expect(container.querySelector('[aria-selected=true]')!.textContent).toBe('@no_ah');await key('Enter');await advance(0);
 const input=container.querySelector('textarea')!;expect(input.value).toBe('First @no_ah and @other');expect(input.selectionStart).toBe(12);expect(document.activeElement).toBe(input);
 expect(container.querySelector('[role=listbox]')).toBeNull();
});
test('mouse/touch click selection inserts canonical punctuation and ArrowUp wraps',async()=>{
 await render();await type('@no');await advance();await key('ArrowUp');expect(container.querySelector('[aria-selected=true]')!.textContent).toBe('@no_ah');
 await act(async()=>container.querySelector<HTMLButtonElement>('[role=option]')!.click());await advance(0);expect(container.querySelector('textarea')!.value).toBe('@Noah.Coach');
});
test('stale responses are canceled and cannot replace current suggestions',async()=>{
 let resolve!:(value:unknown)=>void;mockFetch.mockReturnValueOnce(new Promise(finish=>{resolve=finish;}));
 await render();await type('@n');await advance();const oldSignal=mockFetch.mock.calls[0][1].signal as AbortSignal;
 await type('@other');expect(oldSignal.aborted).toBe(true);await advance();
 await act(async()=>resolve({ok:true,json:async()=>({accounts:[{...accounts[0],username:'STALE'}]})}));
 expect(container.textContent).not.toContain('STALE');expect(container.querySelector('textarea')!.value).toBe('@other');
});
test('failures leave typing available and moving outside the token removes suggestions',async()=>{
 mockFetch.mockRejectedValueOnce(new Error('offline'));await render();await type('@no');await advance();expect(container.querySelector('[role=listbox]')).toBeNull();
 await type('@no more');await advance();expect(container.querySelector('textarea')!.disabled).toBe(false);expect(container.querySelector('textarea')!.value).toBe('@no more');
 expect(mockFetch).toHaveBeenCalledTimes(1);
});
