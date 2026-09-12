/** @jest-environment ./test-support/search-postgres-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { interpretSearch } from "@/lib/searchQuery";
declare const createSearchPostgres: () => PGlite;
let db: PGlite;
jest.setTimeout(90000);
beforeAll(async () => {
  db = createSearchPostgres();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table profiles (id uuid primary key, username text, full_name text, avatar_url text, tagline text, bio text, interests jsonb, banned_at timestamptz, created_at timestamptz default now(), stripe_account_id text, stripe_onboarding_complete boolean);
    create table posts (id uuid primary key, creator_id uuid, title text, content text, caption text, hashtags text[], tags text[], topics text[], hidden_at timestamptz, removed_at timestamptz, created_at timestamptz default now(), video_url text, poster_url text, likes_count integer, product_id uuid, offering_id uuid, allow_booking boolean, booking_url text, duration_seconds integer);
    create table products (id uuid primary key,creator_id uuid,title text,description text,type text,active boolean,product_id uuid,amount_cents integer,price_cents integer,currency text,created_at timestamptz default now());
    create table offerings (id uuid primary key, creator_id uuid, title text, product_metadata jsonb, is_active boolean, created_at timestamptz default now(), price_cents integer, currency text, type text);`);
  await db.exec(readFileSync("supabase/schema/058-search-relevance.sql", "utf8"));
  await db.exec(readFileSync("supabase/schema/059-search-video-processing.sql", "utf8"));
});
afterAll(async () => { await db?.close(); });
const luis = "11111111-1111-4111-8111-111111111111";
const unrelated = "22222222-2222-4222-8222-222222222222";
const postId = "33333333-3333-4333-8333-333333333333";
beforeEach(async () => {
  await db.exec("truncate profiles,posts,offerings,products,search_video_text_v1;");
  await db.query("insert into profiles(id,username,bio,interests) values ($1,'luis','1M in Ecom sales','[]'),($2,'learner','I love yoga','[\"ecommerce\"]')", [luis,unrelated]);
  await db.query("insert into posts(id,creator_id,content,hashtags) values ($1,$2,'I help beginners build stores',array['ecommerce','dropshipping'])",[postId,luis]);
});
async function search(q: string, page=0, size=20) {
  const parsed = interpretSearch(q);
  const result = await db.query<{result: {creators: Array<{id:string;score:number}>, items: Array<{id:string}>, offerings: unknown[], totals: {creators:number;videos:number}}}>("select search_relevance_v1($1,$2,$3,$4) result",[parsed.normalized,parsed.related,page,size]);
  return result.rows[0].result;
}
test("discovers Luis from existing public text and real hashtag arrays, without learning interests",async()=>{
  for(const query of ['ecom','e-commerce','ecommerce','#ecommerce']) {
    const result=await search(query);
    expect(result.creators.map(c=>c.id)).toEqual([luis]);
    expect(result.items.map(p=>p.id)).toEqual([postId]);
  }
});
test("does not produce unrelated fallback profiles",async()=>{
  expect(await search('qzxvnone')).toMatchObject({creators:[],items:[],offerings:[]});
});
test("moderation and profile edits take effect immediately",async()=>{
  await db.query("update profiles set bio=null where id=$1",[luis]);
  await db.query("update posts set hidden_at=now() where id=$1",[postId]);
  expect((await search('ecommerce')).creators).toEqual([]);
  await db.query("update posts set hidden_at=null,removed_at=now() where id=$1",[postId]);
  expect((await search('ecommerce')).items).toEqual([]);
  await db.query("update posts set removed_at=null where id=$1",[postId]);
  await db.query("update profiles set banned_at=now() where id=$1",[luis]);
  expect((await search('ecommerce')).creators).toEqual([]);
  expect((await search('ecommerce')).items).toEqual([]);
});
test("keeps the RPC inaccessible to browser roles",async()=>{
  for(const role of ['anon','authenticated']) {
    await db.exec(`set role ${role}`);
    try { await expect(search('ecom')).rejects.toThrow(/permission denied/); }
    finally { await db.exec('reset role'); }
  }
});

test("exact creator names retain their videos without hiding independent topic matches",async()=>{
  expect((await search('luis')).items.map(p=>p.id)).toEqual([postId]);
  await db.query("update profiles set username='ecommerce' where id=$1",[unrelated]);
  const result=await search('ecommerce');
  expect(result.creators[0].id).toBe(unrelated);
  expect(result.items.map(p=>p.id)).toContain(postId);
});

test("discovers public products and booking offers, but excludes drafts and hidden sale posts",async()=>{
  const productId='44444444-4444-4444-8444-444444444444';
  await db.query("insert into products(id,creator_id,title,description,type,active) values ($1,$2,'Store reviews','Personal Shopify store coaching','course',true)",[productId,luis]);
  expect((await search('store coaching')).offerings).toHaveLength(0);
  await db.query("update posts set product_id=$1 where id=$2",[productId,postId]);
  const found=await search('store coaching');
  expect(found.offerings).toHaveLength(1);
  expect(found.creators.map(c=>c.id)).toContain(luis);
  await db.query("update posts set hidden_at=now() where id=$1",[postId]);
  expect((await search('store coaching')).offerings).toHaveLength(0);
  await db.query("update posts set hidden_at=null,product_id=null,allow_booking=true,booking_url='https://example.invalid/calendar' where id=$1",[postId]);
  expect((await search('consultation')).offerings).toHaveLength(1);
});

test("returns every page without repeating creators",async()=>{
  await db.query("update profiles set bio='Ecommerce coach' where id=$1",[unrelated]);
  const first=await search('ecommerce',0,1),second=await search('ecommerce',1,1);
  expect(first.totals.creators).toBe(2);
  expect(first.creators).toHaveLength(1);
  expect(second.creators).toHaveLength(1);
  expect(first.creators[0].id).not.toBe(second.creators[0].id);
  expect((await search('ecommerce',2,1)).creators).toEqual([]);
});

test("bounded typo matching still finds an e-commerce creator",async()=>{
  expect((await search('ecomerce')).creators.map(c=>c.id)).toContain(luis);
});

test("topic suggestions derive from visible recent content",async()=>{
  const topics=async()=> (await db.query<{result:Array<{label:string}>}>("select search_topics_v1('') result")).rows[0].result;
  expect((await topics()).map(t=>t.label)).toContain('ecommerce');
  await db.query("update posts set removed_at=now() where id=$1",[postId]);
  expect(await topics()).toEqual([]);
});

test("speech and on-screen text find videos and creators, with no duplicate videos",async()=>{
  await db.query("update posts set video_url='https://cdn.example.invalid/public.mp4' where id=$1",[postId]);
  await db.query("insert into search_video_text_v1(post_id,source_url,status,transcript,screen_text) values ($1,'https://cdn.example.invalid/public.mp4','ready','Today we discuss watercolor painting','Ecommerce case study')",[postId]);
  expect((await search('watercolor')).creators.map(c=>c.id)).toEqual([luis]);
  expect((await search('watercolor')).items.map(p=>p.id)).toEqual([postId]);
  expect((await search('ecommerce')).items).toHaveLength(1);
  await db.query("update posts set video_url='https://cdn.example.invalid/replaced.mp4' where id=$1",[postId]);
  expect((await search('watercolor')).items).toEqual([]);
});

test("video processing leases prevent duplicate claims and stale writes",async()=>{
  await db.query("update posts set video_url='https://cdn.example.invalid/public.mp4' where id=$1",[postId]);
  const claim=async()=>(await db.query<{job:{post_id:string;lease_token:string}|null}>("select claim_search_video_v1() job")).rows[0].job;
  const first=await claim();expect(first?.post_id).toBe(postId);expect(await claim()).toBeNull();
  const finish=async(token:string)=>(await db.query<{accepted:boolean}>("select finish_search_video_v1($1,$2,'Watercolor','Painting','test-model',null) accepted",[postId,token])).rows[0].accepted;
  expect(await finish('55555555-5555-4555-8555-555555555555')).toBe(false);
  expect(await finish(first!.lease_token)).toBe(true);
  expect(await claim()).toBeNull();
  expect((await search('watercolor')).items).toHaveLength(1);
});
