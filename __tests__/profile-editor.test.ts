/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
const replace = jest.fn(); const refresh = jest.fn();
const read = jest.fn(); const write = jest.fn(); const upload = jest.fn();
const update = jest.fn(() => ({ eq: write }));
const client = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: read }) }), update }), storage: { from: () => ({ upload, getPublicUrl: () => ({ data: { publicUrl: 'https://example.test/new.png' } }) }) } };
jest.mock('@/lib/supabaseBrowser', () => ({ createBrowserClient: () => client }));
jest.mock('@/lib/useUser', () => ({ useUser: () => ({session:null}), useRequireUser: () => ({ userId:'viewer', loading:false }) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace, refresh }) }));
import Page from '@/app/profile/edit/page';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let container: HTMLDivElement; let root: Root;
const profile = {username:'noah', bio:'hello', tagline:'preserve this', avatar_url:'https://example.test/old.png'};
beforeEach(() => {
  jest.clearAllMocks(); read.mockResolvedValue({data:profile,error:null}); write.mockResolvedValue({error:null}); upload.mockResolvedValue({error:null});
  container=document.createElement('div'); document.body.appendChild(container); root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();jest.restoreAllMocks();});
const render=()=>act(async()=>root.render(createElement(Page)));
const submit=()=>act(async()=>{container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
async function choose(file: File) { const input=container.querySelector<HTMLInputElement>('input[type=file]')!; Object.defineProperty(input,'files',{value:[file], configurable:true}); await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true}))); }
test('loads accessible fields, hides URL editing, and saves existing data without losing tagline',async()=>{
 await render(); expect(container.querySelector<HTMLInputElement>('#profile-username')!.value).toBe('noah'); expect(container.querySelector('label[for="profile-bio"]')).not.toBeNull(); expect(container.querySelector('input[inputmode=url]')).toBeNull();
 await submit(); expect(update).toHaveBeenCalledWith({username:'noah',bio:'hello',tagline:'preserve this',avatar_url:profile.avatar_url}); expect(write).toHaveBeenCalledWith('id','viewer');expect(replace).toHaveBeenCalledWith('/profile');
});
test('blocks editing and submission until the profile loads',async()=>{
 let finish!: (v:unknown)=>void; read.mockReturnValue(new Promise(resolve=>{finish=resolve;})); await render();
 expect(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(true); await submit();expect(update).not.toHaveBeenCalled();
 await act(async()=>finish({data:profile,error:null}));expect(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(false);
});
test('failed reads prevent writes and expose an alert',async()=>{
 jest.spyOn(console,'error').mockImplementation(()=>{});read.mockResolvedValue({data:null,error:{message:'offline'}});await render();await submit();expect(update).not.toHaveBeenCalled();expect(container.querySelector('[role=alert]')!.textContent).toContain("Couldn't load");
});
test('photo upload updates only avatar_url for this viewer and refreshes its preview',async()=>{
 await render();await choose(new File(['image'],'avatar.png',{type:'image/png'}));expect(upload).toHaveBeenCalled();expect(update).toHaveBeenCalledWith({avatar_url:'https://example.test/new.png'});expect(write).toHaveBeenCalledWith('id','viewer');expect(container.querySelector('img')!.src).toBe('https://example.test/new.png');expect(container.querySelector('[role=status]')!.textContent).toContain('photo is live');
});
test('oversized uploads are rejected before storage access',async()=>{
 await render();const file=new File(['image'],'large.png',{type:'image/png'});Object.defineProperty(file,'size',{value:6*1024*1024});await choose(file);expect(upload).not.toHaveBeenCalled();expect(container.querySelector('[role=alert]')!.textContent).toContain('under 5MB');
});
test('failed photo writes retain the saved preview and show the error',async()=>{
 await render();write.mockResolvedValue({error:{message:'Upload could not be saved'}});await choose(new File(['image'],'avatar.png',{type:'image/png'}));expect(container.querySelector('img')!.src).toBe(profile.avatar_url);expect(container.querySelector('[role=alert]')!.textContent).toContain('Upload could not be saved');
});
test('cancel returns to profile without updating it',async()=>{
 await render();const cancel=Array.from(container.querySelectorAll('button')).find(b=>b.textContent==='Cancel')!;await act(async()=>cancel.click());expect(update).not.toHaveBeenCalled();expect(replace).toHaveBeenCalledWith('/profile');
});
