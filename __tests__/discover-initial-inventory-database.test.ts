/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const id=(n:number)=>'00000000-0000-0000-0000-'+n.toString(16).padStart(12,'0');
jest.setTimeout(90000);
beforeAll(async()=>{
 db=createLocalPostgres();
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table public.posts(id uuid primary key,creator_id uuid,product_id uuid,offering_id uuid,
 title text,content text,caption text,interests text[],topics text[],hashtags text[],created_at timestamptz,
 video_url text,poster_url text,price_cents bigint,allow_booking bool,booking_url text,likes_count int,
 comments_count int,shares_count int,purchase_count int,active bool,hidden_at timestamptz,removed_at timestamptz,private_extra text);
 create table public.profiles(id uuid primary key,full_name text,username text,avatar_url text,banned_at timestamptz,
 stripe_account_id text,stripe_onboarding_complete bool,private_extra text);
 create table public.products(id uuid primary key,product_id uuid,creator_id uuid,title text,description text,type text,
 price_cents bigint,amount_cents bigint,active bool,private_extra text);
 create index products_legacy_id on public.products(product_id);
 create table public.offerings(id uuid primary key,creator_id uuid,title text,type text,product_metadata jsonb,is_active bool,private_extra text);
 insert into profiles(id,username,private_extra) values('${id(9000)}','creator','private profile');
 insert into products(id,product_id,creator_id,title,active,private_extra) values('${id(9001)}','${id(9002)}','${id(9000)}','Product',true,'private product');
 insert into offerings(id,creator_id,title,is_active,private_extra) values('${id(9003)}','${id(9000)}','Offer',true,'private offer');
 insert into posts(id,creator_id,product_id,offering_id,title,active,private_extra)
 select ('00000000-0000-0000-0000-'||lpad(to_hex(n),12,'0'))::uuid,'${id(9000)}',
 case when n%2=0 then '${id(9001)}'::uuid else '${id(9002)}'::uuid end,'${id(9003)}','Post '||n,true,'private post'
 from generate_series(0,1001) s(n) order by n desc;
 grant select on posts,profiles,products,offerings to service_role;`);
 await db.exec(readFileSync('supabase/migrations/20260915052139_discover_inventory_batch.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20260916194615_discover_initial_inventory_page.sql','utf8'));
});
afterAll(async()=>{await db.close();});
const page=async(after:string|null=null,limit=1000)=>(await db.query<{data:any}>(
 'select public.discover_initial_inventory_page_v1($1::uuid,$2::integer) as data',[after,limit])).rows[0].data;

test('keyset pages include nil UUID, exceed 1000 total rows, are ordered and do not skip or duplicate posts',async()=>{
 await db.exec('set role service_role');try{
  const first=await page(),second=await page(first.posts.at(-1).id),last=await page(second.posts.at(-1).id);
  expect(first.posts).toHaveLength(1000);expect(second.posts).toHaveLength(2);expect(last.posts).toEqual([]);
  expect([...first.posts,...second.posts].map(p=>p.id)).toEqual(Array.from({length:1002},(_,n)=>id(n)));
 }finally{await db.exec('reset role');}
});

test('matches the existing inventory fields and linked/legacy metadata without private extra columns',async()=>{
 const current=await page(null,200),ids=current.posts.map((p:any)=>p.id);
 const old=(await db.query<{data:any}>('select discover_inventory_batch_v1($1::uuid[]) as data',[ids])).rows[0].data;
 for(const key of ['posts','profiles','primaryProducts','legacyProducts','offerings']){
  const sort=(rows:any[])=>rows.slice().sort((a,b)=>a.id.localeCompare(b.id));
  expect(sort(current[key])).toEqual(sort(old[key]));expect(current[key].every((r:any)=>!('private_extra' in r))).toBe(true);
 }
 expect(current.primaryProducts[0].id).toBe(id(9001));expect(current.legacyProducts[0].product_id).toBe(id(9002));
});

test('returns moderation fields to the unchanged mapper and observes fresh changes on later calls',async()=>{
 await db.exec('begin');try{
  await db.exec(`update posts set hidden_at=now(),active=false where id='${id(0)}';update profiles set banned_at=now();`);
  const changed=await page(null,1);expect(changed.posts[0].hidden_at).not.toBeNull();expect(changed.posts[0].active).toBe(false);
  expect(changed.profiles[0].banned_at).not.toBeNull();
 }finally{await db.exec('rollback');}
});

test('denies anonymous and authenticated callers and preserves invoker table permissions',async()=>{
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);try{await expect(page()).rejects.toThrow(/permission denied/);}finally{await db.exec('reset role');}}
 await db.exec('revoke select on profiles from service_role');await db.exec('set role service_role');
 try{await expect(page()).rejects.toThrow(/permission denied/);}finally{await db.exec('reset role');await db.exec('grant select on profiles to service_role');}
});

test.each([0,-1,1001,null])('refuses invalid page bounds %s',async limit=>{
 await expect(page(null,limit as any)).rejects.toMatchObject({code:'22023'});
});
