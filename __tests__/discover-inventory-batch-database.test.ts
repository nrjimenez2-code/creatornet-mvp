/** @jest-environment ./test-support/pglite-environment.cjs */
import type {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
const post='11111111-1111-4111-8111-111111111111', creator='22222222-2222-4222-8222-222222222222';
jest.setTimeout(90000);
beforeAll(async()=>{
 db=createLocalPostgres();
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table posts(id uuid primary key,creator_id uuid,product_id uuid,offering_id uuid,
 title text,content text,caption text,interests text[],topics text[],hashtags text[],created_at timestamptz,
 video_url text,poster_url text,price_cents bigint,allow_booking bool,booking_url text,likes_count int,
 comments_count int,shares_count int,purchase_count int,active bool,hidden_at timestamptz,removed_at timestamptz);
 create table profiles(id uuid primary key,full_name text,username text,avatar_url text,banned_at timestamptz,
 stripe_account_id text,stripe_onboarding_complete bool,private_extra text);
 create table products(id uuid primary key,product_id uuid,creator_id uuid,title text,description text,
 type text,price_cents bigint,amount_cents bigint,active bool);
 create table offerings(id uuid primary key,creator_id uuid,title text,type text,product_metadata jsonb,is_active bool);
 insert into profiles(id,username,private_extra) values('${creator}','creator','not in response');
 insert into posts(id,creator_id,title,active) values('${post}','${creator}','visible',true);
 grant select on posts,profiles,products,offerings to service_role;`);
 await db.exec(readFileSync('supabase/migrations/20260915052139_discover_inventory_batch.sql','utf8'));
 await db.exec(`create table discover_sessions_v1(id uuid primary key,actor text,post_ids uuid[],expires_at timestamptz);
 insert into discover_sessions_v1 values('${post}','anon:owner',array['${post}'::uuid],now()+interval '1 hour');
 grant select on discover_sessions_v1 to service_role;`);
 await db.exec(readFileSync('supabase/migrations/20260915054818_discover_page_inventory.sql','utf8'));
 await db.exec(`alter table discover_sessions_v1 add column audiences jsonb default '{}'::jsonb`);
 await db.exec(readFileSync('supabase/migrations/20260915065451_discover_event_context.sql','utf8'));
});
test('combined page query enforces ownership, expiry, role and page bounds',async()=>{
 const sql='select discover_page_inventory_v1($1::uuid,$2::text,$3::bigint,$4::integer) as data';
 await db.exec('set role service_role');
 try {
  const {rows}=await db.query<{data:any}>(sql,[post,'anon:owner',0,5]);
  expect(rows[0].data.post_ids).toEqual([post]);
  expect(rows[0].data.inventory.posts[0].id).toBe(post);
  await expect(db.query(sql,[post,'anon:other',0,5])).rejects.toThrow('Feed session unavailable');
  await expect(db.query(sql,[post,'anon:owner',-1,5])).rejects.toThrow('Invalid feed page');
  await expect(db.query(sql,[post,'anon:owner',0,51])).rejects.toThrow('Invalid feed page');
  const empty=await db.query<{data:any}>(sql,[post,'anon:owner',Number.MAX_SAFE_INTEGER,5]);
  expect(empty.rows[0].data.inventory.posts).toEqual([]);
 } finally {await db.exec('reset role');}
 for(const role of ['anon','authenticated']) {
  await db.exec('set role '+role);
  try {await expect(db.query(sql,[post,'anon:owner',0,5])).rejects.toThrow(/permission denied/);}
  finally {await db.exec('reset role');}
 }
 await db.exec(`update discover_sessions_v1 set expires_at=now()-interval '1 second'`);
 await expect(db.query(sql,[post,'anon:owner',0,5])).rejects.toThrow('Feed session unavailable');
});
afterAll(async()=>{await db.close();});

test('event context requires owned unexpired membership and fresh moderation, and is private',async()=>{
 await db.exec('begin');
 const sql='select discover_event_context_v1($1::uuid,$2::text,$3::uuid) as data';
 const context=async(actor='anon:owner',postId=post)=>(await db.query<{data:any}>(sql,[post,actor,postId])).rows[0].data;
 try {
  await db.exec(`update discover_sessions_v1 set expires_at=now()+interval '1 hour';update posts set active=true,hidden_at=null,removed_at=null;update profiles set banned_at=null;`);
  await db.exec('set role service_role');
  expect((await context()).post.id).toBe(post);
  expect(await context('anon:other')).toBeNull();
  expect(await context('anon:owner',creator)).toBeNull();
  await db.exec('reset role');
  for(const change of [
   `update posts set active=false`, `update posts set hidden_at=now()`,
   `update posts set removed_at=now()`, `update profiles set banned_at=now()`,
   `update discover_sessions_v1 set expires_at=now()-interval '1 second'`,
   `update discover_sessions_v1 set post_ids='{}'`,
  ]) {
   await db.exec('savepoint eligibility');await db.exec(change);
   expect(await context()).toBeNull();
   await db.exec('rollback to eligibility');
  }
  for(const role of ['anon','authenticated']) {
   await db.exec('savepoint roles');
   await db.exec('set role '+role);
   await expect(context()).rejects.toThrow(/permission denied/);
   // A failed SQL command aborts this transaction; roll back the role-test savepoint.
   await db.exec('rollback to roles');
  }
 } finally {await db.exec('rollback');}
});
test('only requested post data and allowed profile columns are returned',async()=>{
 const {rows}=await db.query<{data:any}>('select discover_inventory_batch_v1($1::uuid[]) as data',[[post]]);
 expect(rows[0].data.posts).toHaveLength(1);
 expect(rows[0].data.posts[0].id).toBe(post);
 expect(rows[0].data.profiles[0].username).toBe('creator');
 expect(rows[0].data.profiles[0]).not.toHaveProperty('private_extra');
 expect(rows[0].data.primaryProducts).toEqual([]);
});
test('public clients cannot execute the private inventory RPC',async()=>{
 for(const role of ['anon','authenticated']) {
  await db.exec('set role '+role);
  try {await expect(db.query('select discover_inventory_batch_v1($1::uuid[])',[[post]])).rejects.toThrow(/permission denied/);}
  finally {await db.exec('reset role');}
 }
 await db.exec('set role service_role');
 try {await expect(db.query('select discover_inventory_batch_v1($1::uuid[])',[[post]])).resolves.toBeDefined();}
 finally {await db.exec('reset role');}
});
test('visibility data is read fresh and oversized batches are rejected',async()=>{
 await db.exec(`update posts set active=false,hidden_at=now() where id='${post}';update profiles set banned_at=now() where id='${creator}'`);
 const {rows}=await db.query<{data:any}>('select discover_inventory_batch_v1($1::uuid[]) as data',[[post]]);
 expect(rows[0].data.posts[0].active).toBe(false);
 expect(rows[0].data.posts[0].hidden_at).not.toBeNull();
 expect(rows[0].data.profiles[0].banned_at).not.toBeNull();
 await expect(db.query('select discover_inventory_batch_v1($1::uuid[])',[Array(201).fill(post)])).rejects.toThrow('Invalid inventory batch');
});
