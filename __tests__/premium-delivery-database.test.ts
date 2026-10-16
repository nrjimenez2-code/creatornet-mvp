/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const creator="11111111-1111-4111-8111-111111111111";
const buyer="22222222-2222-4222-8222-222222222222";
const other="33333333-3333-4333-8333-333333333333";
const product="44444444-4444-4444-8444-444444444444";
const asset="55555555-5555-4555-8555-555555555555";
const post="66666666-6666-4666-8666-666666666666";
const order="77777777-7777-4777-8777-777777777777";
const purchase="88888888-8888-4888-8888-888888888888";
jest.setTimeout(90000);
beforeAll(async()=>{
 db=createLocalPostgres();
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create table profiles(id uuid primary key);
 insert into profiles values('${creator}'),('${buyer}'),('${other}');
 create table products(id uuid primary key,creator_id uuid,title text,type text,price_cents bigint,amount_cents bigint,currency text,active boolean default true,is_active boolean default true,discord_invite_url text,external_url text,premium_video_url text,discord_channel_id text,whop_listing_id text);
 create table posts(id uuid primary key,creator_id uuid,title text,video_url text,product_id uuid,offering_id uuid,
  price_cents bigint,allow_booking boolean default false,booking_url text,booking_url_override text,
  tips_enabled boolean default false,premium_path text,cta_type text default 'none');
 create table purchases(id uuid primary key,buyer_id uuid,creator_id uuid,product_id uuid,post_id uuid,
  order_id uuid,amount_cents bigint,currency text,status text,access_granted boolean);
 grant select,insert,update on posts,products,purchases to authenticated;
 grant select on products to anon;
 grant all on profiles,posts,products,purchases to service_role;
 insert into products(id,creator_id,title,type,price_cents,amount_cents,currency) values('${product}','${creator}','Masterclass','video',5000,5000,'usd');
 insert into posts(id,creator_id,title,product_id,allow_booking,booking_url,premium_path,price_cents)
 values('${post}','${creator}','Legacy','${product}',true,'https://cal.com/creator','${creator}/legacy.mp4',5000);`);
 await db.exec(readFileSync("supabase/migrations/20260930175120_composer_premium_delivery.sql","utf8"));
});
afterAll(async()=>{await db.close();});
beforeEach(async()=>{await db.exec("reset role; begin");});
afterEach(async()=>{await db.exec("rollback; reset role");});
async function ready(id=asset,owner=creator,status="ready"){
 await db.query("insert into private_video_assets(id,creator_id,provider,provider_id,status,name,duration_seconds) values($1,$2,'stream',$3,$4,'Lesson',3600)",[id,owner,id.replaceAll("-",""),status]);
}
async function save(videos=[{asset_id:asset,label:"Lesson 1"}],links:unknown[]=[]){
 return (await db.query<{id:string}>("select save_product_delivery_v1($1,$2,$3::jsonb,$4::jsonb) id",[product,creator,JSON.stringify(links),JSON.stringify(videos)])).rows[0].id;
}
async function snapshot(revision:string,amount=5000,user=buyer){
 return db.query("select prepare_checkout_delivery_v1($1,$2,$3,$4,$5)",[order,user,product,revision,amount]);
}
test("legacy Buy wins over Book; existing private file is wrapped without moving or regrouping",async()=>{
 expect((await db.query("select video_action,allow_booking,booking_url,premium_path,action_version from posts")).rows).toEqual([{video_action:"buy",allow_booking:false,booking_url:null,premium_path:creator+"/legacy.mp4",action_version:0}]);
 expect((await db.query("select provider,provider_id,status,legacy_post_id from private_video_assets")).rows).toEqual([{provider:"supabase",provider_id:creator+"/legacy.mp4",status:"ready",legacy_post_id:post}]);
});
test("delivery rejects videos belonging to another creator",async()=>{
 await ready(asset,other);
 await expect(save()).rejects.toThrow(/owned and ready/);
});
test.each(["creating","uploading","processing","failed","canceling","canceled"])("delivery rejects %s videos",async(status)=>{
 await ready(asset,creator,status);
 await expect(save()).rejects.toThrow(/owned and ready/);
});
test("video delivery requires one private video and no links",async()=>{
 await ready();
 await expect(save([])).rejects.toThrow(/Incompatible/);
});
test("multiple ordered videos form one delivery revision",async()=>{
 await ready(); await ready(other);
 await db.exec("update products set type='bundle'");
 const revision=await save([{asset_id:other,label:"First"},{asset_id:asset,label:"Second"}]);
 expect((await db.query("select label,position from product_delivery_videos where revision_id=$1 order by position",[revision])).rows).toEqual([{label:"First",position:0},{label:"Second",position:1}]);
});
test("links are ordered and privately stored; malformed URLs fail",async()=>{
 await db.exec("update products set type='course'");
 const links=[{label:"Discord",url:"https://discord.gg/owned"},{label:"Whop",url:"https://whop.com/owned"}];
 const revision=await save([],links);
 expect((await db.query("select links from product_delivery_revisions where id=$1",[revision])).rows).toEqual([{links}]);
 await expect(save([],[{label:"Unsafe",url:"https://user:pass@example.com"}])).rejects.toThrow(/Invalid access link/);
});
test("checkout freezes saved price and deliverables once",async()=>{
 await ready(); const revision=await save();
 await snapshot(revision); await snapshot(revision);
 expect((await db.query("select count(*)::int n from checkout_delivery_snapshots")).rows).toEqual([{n:1}]);
 await expect(snapshot(revision,4999)).rejects.toThrow(/binding differs/);
});
test("checkout rejects unavailable, price-changed, and no-longer-ready delivery",async()=>{
 await ready(); const revision=await save();
 await db.exec("update products set active=false");
 await expect(snapshot(revision)).rejects.toThrow(/unavailable/);
});
test("edited products cannot remove purchased videos",async()=>{
 await ready(); const revision=await save(); await snapshot(revision);
 await db.query("insert into purchases values($1,$2,$3,$4,$5,$6,5000,'usd','pending',false)",[purchase,buyer,creator,product,post,order]);
 await ready(other); await save([{asset_id:other,label:"Replacement"}]);
 expect((await db.query("select v.asset_id from purchase_deliveries d join checkout_delivery_snapshots s on s.order_id=d.order_id join product_delivery_videos v on v.revision_id=s.revision_id")).rows).toEqual([{asset_id:asset}]);
 await expect(db.exec(`delete from private_video_assets where id='${asset}'`)).rejects.toThrow(/foreign key/);
});
test("purchase cannot claim another buyer's frozen delivery",async()=>{
 await ready(); const revision=await save(); await snapshot(revision);
 await expect(db.query("insert into purchases values($1,$2,$3,$4,$5,$6,5000,'usd','paid',true)",[purchase,other,creator,product,post,order])).rejects.toThrow(/ownership or price/);
});
test("new Buy stores product price and rejects incomplete delivery",async()=>{
 await ready(); await save();
 await db.query("insert into posts(id,creator_id,video_url,product_id,price_cents,video_action,action_version) values($1,$2,'https://public.test/video.mp4',$3,1,'buy',1)",[other,creator,product]);
 expect((await db.query("select price_cents from posts where id=$1",[other])).rows).toEqual([{price_cents:5000}]);
});
test("published actions, selling attachment, and tips cannot be changed even by service",async()=>{
 await db.exec("set role service_role");
 await expect(db.exec("update posts set video_action='book'")).rejects.toThrow(/only when publishing/);
});
test("private delivery tables and RPCs cannot be read or forged through the Data API",async()=>{
 await db.exec("set role authenticated");
 await db.exec("savepoint denied");
 await expect(db.query("select * from private_video_assets")).rejects.toThrow(/permission denied/);
 await db.exec("rollback to denied");
 await expect(db.query("select save_product_delivery_v1($1,$2,'[]','[]')",[product,creator])).rejects.toThrow(/permission denied/);
});
test.each(["anon","authenticated"])("%s can read sales columns but cannot read legacy delivery URLs",async role=>{
 await db.exec("set role "+role);
 expect((await db.query("select title,price_cents,type from products")).rows).toHaveLength(1);
 for(const column of ["discord_invite_url","external_url","premium_video_url","discord_channel_id","whop_listing_id"]){
  await db.exec("savepoint private_column");
  await expect(db.query("select "+column+" from products")).rejects.toThrow(/permission denied/);
  await db.exec("rollback to private_column");
 }
});
test("Data API clients cannot assign a product delivery revision",async()=>{
 await ready(); const revision=await save();
 await db.exec("set role authenticated");
 await expect(db.query("update products set delivery_revision=null where id=$1",[product])).rejects.toThrow(/product service/);
 expect(revision).toBeTruthy();
});
test("Data API clients cannot publish a commercial action",async()=>{
 await db.exec("set role authenticated");
 await expect(db.query("insert into posts(id,creator_id,video_action,tips_enabled) values($1,$2,'tip',true)",[other,creator])).rejects.toThrow(/publishing service/);
});
test("new conflicting buttons and a Book without destination are rejected",async()=>{
 await expect(db.query("insert into posts(id,creator_id,product_id,allow_booking,video_action,action_version) values($1,$2,$3,true,'buy',1)",[other,creator,product])).rejects.toThrow(/Conflicting/);
});
test("frozen delivery rows cannot be edited",async()=>{
 await ready(); const revision=await save();
 await expect(db.query("update product_delivery_videos set label='Changed' where revision_id=$1",[revision])).rejects.toThrow(/immutable/);
});
test("a four-video bundle binds to one purchase with independent ordered progress",async()=>{
 const ids=[asset,other,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
 for(const id of ids)await ready(id);
 await db.exec("update products set type='bundle'");
 const revision=await save(ids.map((id,index)=>({asset_id:id,label:"Lesson "+(index+1)})));await snapshot(revision);
 await db.query("insert into purchases values($1,$2,$3,$4,$5,$6,5000,'usd','paid',true)",[purchase,buyer,creator,product,post,order]);
 for(let index=0;index<ids.length;index++)await db.query("insert into private_video_progress(purchase_id,asset_id,buyer_id,seconds) values($1,$2,$3,$4)",[purchase,ids[index],buyer,10*(index+1)]);
 expect((await db.query("select count(*)::int n from purchase_deliveries")).rows).toEqual([{n:1}]);
 expect((await db.query<{seconds:number}>("select seconds from private_video_progress order by seconds")).rows.map(r=>Number(r.seconds))).toEqual([10,20,30,40]);
});
test("retrying purchase fulfillment does not create a second delivery or permit another purchase for the same order",async()=>{
 await ready();const revision=await save();await snapshot(revision);
 await db.query("insert into purchases values($1,$2,$3,$4,$5,$6,5000,'usd','pending',false)",[purchase,buyer,creator,product,post,order]);
 await db.exec("update purchases set status='paid',access_granted=true");await db.exec("update purchases set status='paid',access_granted=true");
 expect((await db.query("select count(*)::int n from purchase_deliveries")).rows).toEqual([{n:1}]);
 await expect(db.query("insert into purchases values($1,$2,$3,$4,$5,$6,5000,'usd','paid',true)",[other,buyer,creator,product,post,order])).rejects.toThrow(/unique/);
});
test.each(["buyer","video"])("progress cannot claim another %s",async what=>{
 await ready();const revision=await save();await snapshot(revision);await ready(other);
 await db.query("insert into purchases values($1,$2,$3,$4,$5,$6,5000,'usd','paid',true)",[purchase,buyer,creator,product,post,order]);
 await expect(db.query("insert into private_video_progress(purchase_id,asset_id,buyer_id,seconds) values($1,$2,$3,10)",[purchase,what==="video"?other:asset,what==="buyer"?other:buyer])).rejects.toThrow(/ownership|included/);
});
test.each(["anon","authenticated"])("%s can read sales columns but cannot read legacy delivery URLs",async role=>{
 await db.exec("set role "+role);
 expect((await db.query("select title,price_cents from products")).rows).toEqual([{title:"Masterclass",price_cents:5000}]);
 await expect(db.query("select discord_invite_url from products")).rejects.toThrow(/permission denied/);
});
test.each([null,"tip","book"])("new action %p stores an exclusive choice at publish time",async action=>{
 const booking=action==="book";
 await db.query("insert into posts(id,creator_id,video_action,action_version,tips_enabled,allow_booking,booking_url) values($1,$2,$3,1,$4,$5,$6)",[other,creator,action,action==="tip",booking,booking?"https://calendar.invalid/free":null]);
 expect((await db.query("select video_action from posts where id=$1",[other])).rows).toEqual([{video_action:action}]);
});
test("a Book without a destination cannot be published",async()=>{
 await expect(db.query("insert into posts(id,creator_id,video_action,action_version,allow_booking) values($1,$2,'book',1,true)",[other,creator])).rejects.toThrow(/destination/);
});
test("reserved service purchase freezes delivery without replacing the financial order and survives receipt accounting updates",async()=>{
 await ready();const revision=await save();
 await db.query("insert into purchases values($1,$2,$3,$4,$5,null,null,'usd','pending',false)",[purchase,buyer,creator,product,post]);
 expect((await db.query("select order_id from purchases where id=$1",[purchase])).rows).toEqual([{order_id:null}]);
 expect((await db.query("select revision_id,amount_cents from checkout_delivery_snapshots where order_id=$1",[purchase])).rows).toEqual([{revision_id:revision,amount_cents:5000}]);
 await db.query("update purchases set amount_cents=2500,status='active',access_granted=true where id=$1",[purchase]);
 expect((await db.query("select count(*)::int n from purchase_deliveries")).rows).toEqual([{n:1}]);
});
