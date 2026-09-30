/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
const replace = jest.fn(); const refresh = jest.fn();
const read = jest.fn(); const write = jest.fn(); const upload = jest.fn();
const update = jest.fn(() => ({ eq: write }));
const client = { from: () => ({ select: () => ({ eq: () => ({ returns: () => ({ maybeSingle: read }) }) }), update }), storage: { from: () => ({ upload, getPublicUrl: () => ({ data: { publicUrl: 'https://example.test/new.png' } }) }) } };
jest.mock('@/lib/supabaseBrowser', () => ({ createBrowserClient: () => client }));
jest.mock('@/lib/useUser', () => ({ useUser: () => ({session:null}), useRequireUser: () => ({ userId:'viewer', loading:false }) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace, refresh }) }));
jest.mock('@/components/AvatarCropDialog', () => ({
  __esModule: true,
  default: ({onSave,onCancel}: {onSave:(photo:Blob)=>Promise<void>;onCancel:()=>void}) => {
    const {createElement} = jest.requireActual<typeof import('react')>('react');
    return createElement('div',{'data-testid':'crop-dialog'},
      createElement('button',{type:'button',onClick:()=>onSave(new Blob(['cropped'],{type:'image/png'}))},'Save photo'),
      createElement('button',{type:'button',onClick:onCancel},'Cancel crop'));
  },
}));
import Page from '@/app/profile/edit/page';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let container: HTMLDivElement; let root: Root;
const profile = {username:'noah', bio:'hello', tagline:'preserve this', avatar_url:'https://example.test/old.png'};
beforeEach(() => {
  process.env.NEXT_PUBLIC_PROFILE_WEBSITE_READY='true';
  jest.clearAllMocks(); read.mockResolvedValue({data:profile,error:null}); write.mockResolvedValue({error:null,count:1}); upload.mockResolvedValue({error:null});
  URL.createObjectURL=jest.fn(()=>'blob:test-avatar'); URL.revokeObjectURL=jest.fn();
  container=document.createElement('div'); document.body.appendChild(container); root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();jest.restoreAllMocks();delete process.env.NEXT_PUBLIC_PROFILE_WEBSITE_READY;});
const render=()=>act(async()=>root.render(createElement(Page)));
const submit=()=>act(async()=>{container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
async function choose(file: File) { const input=container.querySelector<HTMLInputElement>('input[type=file]')!; Object.defineProperty(input,'files',{value:[file], configurable:true}); await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true}))); }
test('loads accessible fields and saves existing data without losing tagline',async()=>{
 await render(); expect(container.querySelector<HTMLInputElement>('#profile-username')!.value).toBe('noah'); expect(container.querySelector('label[for="profile-bio"]')).not.toBeNull(); expect(container.querySelector('input[inputmode=url]')).not.toBeNull();
 await submit(); expect(update).toHaveBeenCalledWith({username:'noah',bio:'hello',tagline:'preserve this',avatar_url:profile.avatar_url,website_url:null},{count:'exact'}); expect(write).toHaveBeenCalledWith('id','viewer');expect(replace).toHaveBeenCalledWith('/profile');
});
test('blocks editing and submission until the profile loads',async()=>{
 let finish!: (v:unknown)=>void; read.mockReturnValue(new Promise(resolve=>{finish=resolve;})); await render();
 expect(container.querySelector('form')).toBeNull();expect(container.querySelector('[role=status]')?.textContent).toContain('Loading your profile');expect(update).not.toHaveBeenCalled();
 await act(async()=>finish({data:profile,error:null}));expect(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(false);
});
test('failed reads prevent writes and expose an alert',async()=>{
 jest.spyOn(console,'error').mockImplementation(()=>{});read.mockResolvedValue({data:null,error:{message:'offline'}});await render();await submit();expect(update).not.toHaveBeenCalled();expect(container.querySelector('[role=alert]')!.textContent).toContain("Couldn't load");
});
test('photo waits for crop confirmation, then uploads a square PNG for this viewer',async()=>{
 await render();await choose(new File(['image'],'avatar.png',{type:'image/png'}));expect(upload).not.toHaveBeenCalled();expect(container.querySelector('[data-testid=crop-dialog]')).not.toBeNull();
 const save=Array.from(container.querySelectorAll('button')).find(b=>b.textContent==='Save photo')!;
 await act(async()=>save.click());
 expect(upload).toHaveBeenCalledWith(expect.stringMatching(/^viewer\/avatar-.*\.png$/),expect.any(Blob),{cacheControl:'3600',upsert:false,contentType:'image/png'});
 expect(update).toHaveBeenCalledWith({avatar_url:'https://example.test/new.png'});expect(write).toHaveBeenCalledWith('id','viewer');expect(container.querySelector('img')!.src).toBe('https://example.test/new.png');expect(container.querySelector('[role=status]')!.textContent).toContain('photo is live');
});
test('oversized uploads are rejected before storage access',async()=>{
 await render();const file=new File(['image'],'large.png',{type:'image/png'});Object.defineProperty(file,'size',{value:6*1024*1024});await choose(file);expect(upload).not.toHaveBeenCalled();expect(container.querySelector('[role=alert]')!.textContent).toContain('under 5MB');
});
test('failed photo writes retain the saved preview and show the error',async()=>{
 await render();write.mockResolvedValue({error:{message:'Upload could not be saved'}});await choose(new File(['image'],'avatar.png',{type:'image/png'}));
 const save=Array.from(container.querySelectorAll('button')).find(b=>b.textContent==='Save photo')!;await act(async()=>save.click());
 expect(container.querySelector('img')!.src).toBe(profile.avatar_url);expect(container.querySelector('[role=alert]')!.textContent).toContain('Upload could not be saved');
});
test('canceling the crop keeps the existing photo',async()=>{
 await render();await choose(new File(['image'],'avatar.png',{type:'image/png'}));
 const cancel=Array.from(container.querySelectorAll('button')).find(b=>b.textContent==='Cancel crop')!;await act(async()=>cancel.click());
 expect(upload).not.toHaveBeenCalled();expect(container.querySelector('img')!.src).toBe(profile.avatar_url);expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-avatar');
});
test('cancel returns to profile without updating it',async()=>{
 await render();const cancel=Array.from(container.querySelectorAll('button')).find(b=>b.textContent==='Cancel')!;await act(async()=>cancel.click());expect(update).not.toHaveBeenCalled();expect(replace).toHaveBeenCalledWith('/profile');
});

async function setWebsite(value:string) {
 const input=container.querySelector<HTMLInputElement>('#profile-website')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
}
test('loads, normalizes, persists and clears the website',async()=>{
 read.mockResolvedValue({data:{...profile,website_url:'https://example.com/old'},error:null});await render();
 expect(container.querySelector<HTMLInputElement>('#profile-website')!.value).toBe('https://example.com/old');
 await setWebsite('example.com/path?q=1#anchor');await submit();expect(update).toHaveBeenLastCalledWith(expect.objectContaining({website_url:'https://example.com/path?q=1#anchor'}),{count:'exact'});
 await setWebsite('');await submit();expect(update).toHaveBeenLastCalledWith(expect.objectContaining({website_url:null}),{count:'exact'});
});
test('invalid website blocks saving and focuses an accessible field error',async()=>{
 await render();await setWebsite('javascript:alert(1)');await submit();
 expect(update).not.toHaveBeenCalled();expect(container.querySelector('#profile-website')!.getAttribute('aria-invalid')).toBe('true');
 expect(container.querySelector('#website-error')!.getAttribute('role')).toBe('alert');expect(document.activeElement?.id).toBe('profile-website');
 await setWebsite('example.com');await submit();expect(update).toHaveBeenCalled();
});
test('failed website saves keep editing available and do not navigate',async()=>{
 await render();await setWebsite('example.com');write.mockResolvedValue({error:{message:'Save failed'}});await submit();
 expect(replace).not.toHaveBeenCalled();expect(refresh).not.toHaveBeenCalled();expect(container.querySelector('[role=alert]')!.textContent).toContain('Save failed');
 expect(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(false);expect(container.querySelector<HTMLInputElement>('#profile-website')!.value).toBe('example.com');
});
test('schema gate hides website editing and never writes the missing column',async()=>{
 delete process.env.NEXT_PUBLIC_PROFILE_WEBSITE_READY;await render();expect(container.querySelector('#profile-website')).toBeNull();await submit();
 expect(update).toHaveBeenCalledWith({username:'noah',bio:'hello',tagline:'preserve this',avatar_url:profile.avatar_url},{count:'exact'});
});
test('a zero-row update is a save failure, not a successful navigation',async()=>{
 await render();write.mockResolvedValue({error:null,count:0});await submit();expect(replace).not.toHaveBeenCalled();expect(container.querySelector('[role=alert]')!.textContent).toContain('could not be saved');
});
