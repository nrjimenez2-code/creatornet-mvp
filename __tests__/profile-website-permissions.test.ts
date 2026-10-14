/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
const owner='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const sql=readFileSync(path.join(process.cwd(),'supabase/migrations/20260930022954_profile_website.sql'),'utf8');
jest.setTimeout(90000);
beforeEach(async()=>{
 db=createLocalPostgres();
 await db.exec(`create role anon; create role authenticated; create schema auth;
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth to anon,authenticated;
 create table public.profiles(id uuid primary key,bio text,username text,role text,stripe_account_id text,total_earnings_cents bigint);
 insert into public.profiles(id,username,bio) values ('${owner}','owner','keep me'),('${other}','other','other bio');
 alter table public.profiles enable row level security;
 create policy profiles_read_own on public.profiles for select using (auth.uid()=id);
 create policy profiles_update_own on public.profiles for update using (auth.uid()=id) with check (auth.uid()=id);
 grant select on public.profiles to anon,authenticated;
 grant update(bio,username) on public.profiles to authenticated;`);
});
afterEach(async()=>{await db.close();});
async function asRole(role:'anon'|'authenticated',id:string,run:()=>Promise<void>){
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec(`set role ${role}`);
 try{await run();}finally{await db.exec('reset role');}
}
test('migration defaults to null; owner persists and clears website while preserving the bio',async()=>{
 await db.exec(sql);expect((await db.query('select website_url from public.profiles')).rows).toEqual([{website_url:null},{website_url:null}]);
 await asRole('authenticated',owner,async()=>{
  expect((await db.query('update public.profiles set website_url=$1 where id=$2 returning id',['https://example.com/path?x=1#part',owner])).rows).toEqual([{id:owner}]);
  expect((await db.query('select bio,website_url from public.profiles')).rows).toEqual([{bio:'keep me',website_url:'https://example.com/path?x=1#part'}]);
  await db.query('update public.profiles set website_url=null where id=$1',[owner]);
 });
 expect((await db.query('select website_url from public.profiles where id=$1',[owner])).rows).toEqual([{website_url:null}]);
});
test('other users and signed-out visitors cannot change the website; protected columns remain protected',async()=>{
 await db.exec(sql);
 await asRole('authenticated',other,async()=>{
  expect((await db.query('update public.profiles set website_url=$1 where id=$2 returning id',['https://example.com/',owner])).rows).toEqual([]);
  for(const column of ['role','stripe_account_id','total_earnings_cents','id']) await expect(db.query(`update public.profiles set ${column}=${column}`)).rejects.toThrow(/permission denied/i);
 });
 await asRole('anon','',async()=>{await expect(db.query("update public.profiles set website_url='https://example.com/'")).rejects.toThrow(/permission denied/i);});
 expect((await db.query('select website_url from public.profiles')).rows).toEqual([{website_url:null},{website_url:null}]);
});
test.each(['javascript:alert(1)','https://user:pass@example.com','https://@example.com','https://example.com\\oops','https://example.com/a b','https://example.com/'+ 'x'.repeat(2048)])('database rejects unsafe or oversized website %s',async(value)=>{
 await db.exec(sql);await asRole('authenticated',owner,async()=>{await expect(db.query('update public.profiles set website_url=$1 where id=$2',[value,owner])).rejects.toThrow(/check constraint/i);});
});
test('permission drift aborts migration before adding the column',async()=>{
 await db.exec('grant update on public.profiles to authenticated');
 await expect(db.exec(sql)).rejects.toThrow(/protected-column baseline/i);await db.exec('rollback');
 expect((await db.query("select column_name from information_schema.columns where table_name='profiles' and column_name='website_url'")).rows).toEqual([]);
});
