import { NextRequest } from "next/server";
import {
  createMockClient,
  type MockClient,
  type Op,
} from "./__mocks__/supabaseQueryMock";
let db: MockClient;
let actor = "user:viewer";
let expired = false;
let banned = false;
let ids: string[] = [];
let hidden = new Set<string>();
const auth = {
  auth: {
    getUser: async () => ({ data: { user: { id: "viewer" } }, error: null }),
  },
  rpc: jest.fn(),
};
jest.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    return db;
  },
}));
jest.mock("@/lib/supabaseServer", () => ({ createServerClient: () => auth }));
import { GET } from "@/app/api/feed/route";
import { POST } from "@/app/api/feed-events/route";
function respond(op: Op): {data: any; error: unknown} {
  if(op.table === 'discover_page_inventory_v1' || op.table === 'discover_compact_page_v1') {
    const args=op.payload as {p_actor:string;p_offset:number;p_limit:number};
    if(args.p_actor!==actor || expired) return {data:null,error:{code:'CN001'}};
    const selected=ids.slice(args.p_offset,args.p_offset+args.p_limit);
    return {data:{...(op.table==='discover_compact_page_v1'?{page_post_ids:selected,total_count:ids.length}:{post_ids:ids}),expires_at:new Date(Date.now()+3600000).toISOString(),
      inventory:respond({...op,table:'discover_inventory_batch_v1',payload:{p_ids:selected}}).data},error:null};
  }
  if(op.table === 'discover_inventory_batch_v1') {
    const selected = (op.payload as {p_ids:string[]}).p_ids;
    return {data:{
      posts:respond({...op,table:'posts',inFilters:[{column:'id',values:selected}]}).data,
      profiles:respond({...op,table:'profiles'}).data,
      primaryProducts:[],legacyProducts:[],offerings:[],
    },error:null};
  }
  if (op.table === "discover_sessions_v1")
    return {
      data:
        op.filters.actor === actor
          ? {
              post_ids: ids,
              audiences: {},
              expires_at: new Date(
                Date.now() + (expired ? -1000 : 3600000),
              ).toISOString(),
            }
          : null,
      error: null,
    };
  if (op.table === "posts")
    return {
      data: (op.inFilters[0]?.values ?? []).map((id) => ({
        id,
        creator_id: "creator",
        title: String(id),
        poster_url: "https://example.test/p.jpg",
        hidden_at: hidden.has(String(id)) ? "2026-09-12" : null,
      })),
      error: null,
    };
  if (op.table === "profiles")
    return {
      data: [
        {
          id: "creator",
          username: "creator",
          banned_at: banned ? "2026-09-12" : null,
        },
      ],
      error: null,
    };
  return { data: [], error: null };
}
beforeEach(() => {
  delete process.env.DISCOVER_COMPACT_PAGE_ENABLED;
  delete process.env.DISCOVER_PAGE_INVENTORY_ENABLED;
  process.env.DISCOVER_V4_ENABLED = "true";
  actor = "user:viewer";
  expired = false;
  banned = false;
  hidden = new Set();
  ids = Array.from({ length: 2005 }, (_, i) => "p" + i);
  db = createMockClient(respond);
});
afterAll(() => {
  delete process.env.DISCOVER_COMPACT_PAGE_ENABLED;
  delete process.env.DISCOVER_PAGE_INVENTORY_ENABLED;
  delete process.env.DISCOVER_V4_ENABLED;
});
const request = (query: string) =>
  new NextRequest("https://example.test/api/feed?session=existing&" + query);
test.each([false,true])("pagination crosses the old 2000 cap and keeps snapshot order (compact=%s)", async compact => {
  if(compact){process.env.DISCOVER_COMPACT_PAGE_ENABLED='true';process.env.DISCOVER_PAGE_INVENTORY_ENABLED='true';}
  let response = await GET(request("offset=1998&limit=5"));
  let body = await response.json();
  expect(response.status).toBe(200);
  expect(body.items.map((p: { post_id: string }) => p.post_id)).toEqual([
    "p1998",
    "p1999",
    "p2000",
    "p2001",
    "p2002",
  ]);
  expect(body.nextOffset).toBe(2003);
  expect(body.hasMore).toBe(true);
  response = await GET(request("offset=2003&limit=5"));
  body = await response.json();
  expect(body.items.map((p: { post_id: string }) => p.post_id)).toEqual([
    "p2003",
    "p2004",
  ]);
  expect(body.hasMore).toBe(false);
  expect(
    db.opsFor("posts").every((op) => op.inFilters[0].values.length <= 5),
  ).toBe(true);
});
test("sessions cannot be read by another viewer or after expiration", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    actor = "user:someone-else";
    const unavailable = await GET(request("offset=0"));
    expect(unavailable.status).toBe(410);
    const safeError = await unavailable.json();
    expect(safeError).toEqual({ error: "This feed needs to be refreshed.", code: "DISCOVER_SESSION_UNAVAILABLE" });
    expect(unavailable.headers.get("cache-control")).toBe("private, no-store");
    actor = "user:viewer";
    expired = true;
    const expiredResponse = await GET(request("offset=0"));
    expect(expiredResponse.status).toBe(410);
    expect(await expiredResponse.json()).toEqual(safeError);
  } finally {
    log.mockRestore();
  }
});
test("moderation is rechecked, and empty removed pages do not strand later results", async () => {
  ids = ["p1", "p2", "p3"];
  hidden = new Set(["p1", "p2"]);
  const body = await (await GET(request("offset=0&limit=2"))).json();
  expect(body.items.map((p: { post_id: string }) => p.post_id)).toEqual(["p3"]);
  expect(body.nextOffset).toBe(3);
  banned = true;
  expect((await (await GET(request("offset=0&limit=2"))).json()).items).toEqual(
    [],
  );
});
test("invalid offsets and fabricated commercial events are rejected", async () => {
  expect((await GET(request("offset=-1"))).status).toBe(400);
  expect((await GET(request("offset=NaN"))).status).toBe(400);
  const response = await POST(
    new NextRequest("https://example.test/api/feed-events", {
      method: "POST",
      body: JSON.stringify({
        session: "existing",
        postId: "p1",
        kind: "purchase",
        amount_cents: 999999,
      }),
    }),
  );
  expect(response.status).toBe(400);
  expect(db.opsFor("discover_events_v1")).toHaveLength(0);
});
test.each([false,true])('combined page preserves moderation skipping, ownership and expiry (compact=%s)',async compact=>{
 process.env.DISCOVER_COMPACT_PAGE_ENABLED=String(compact);
 process.env.DISCOVER_PAGE_INVENTORY_ENABLED='true';
 hidden=new Set(ids.slice(0,5));
 const first=await (await GET(request('offset=0&limit=5'))).json();
 expect(first.items.map((p:{post_id:string})=>p.post_id)).toEqual(ids.slice(5,10));
 expect(first.nextOffset).toBe(10);
 expect(db.opsFor('discover_sessions_v1')).toHaveLength(0);
 expect(db.opsFor('posts')).toHaveLength(0);
 banned=true;
 ids=ids.slice(0,10);
 const moderated=await (await GET(request('offset=5&limit=5'))).json();
 expect(moderated.items).toEqual([]);
 const log=jest.spyOn(console,'error').mockImplementation(()=>{});
 try {
  actor='user:other';
  const wrongOwner = await GET(request('offset=0&limit=5'));
  expect(wrongOwner.status).toBe(410);
  expect(await wrongOwner.json()).toEqual({error:'This feed needs to be refreshed.',code:'DISCOVER_SESSION_UNAVAILABLE'});
  actor='user:viewer'; expired=true;
  const oldSession = await GET(request('offset=0&limit=5'));
  expect(oldSession.status).toBe(410);
  expect(await oldSession.json()).toEqual({error:'This feed needs to be refreshed.',code:'DISCOVER_SESSION_UNAVAILABLE'});
 } finally {log.mockRestore();}
});

test('malformed compact metadata fails closed without returning inventory',async()=>{
 process.env.DISCOVER_PAGE_INVENTORY_ENABLED='true';process.env.DISCOVER_COMPACT_PAGE_ENABLED='true';
 const log=jest.spyOn(console,'error').mockImplementation(()=>{});
 try{for(const patch of [{total_count:-1},{page_post_ids:['p1','p1']},{total_count:NaN},{page_post_ids:[]}]){
  db=createMockClient(op=>{const result=respond(op);if(op.table==='discover_compact_page_v1')Object.assign(result.data,patch);return result;});
  const response=await GET(request('offset=0&limit=2'));expect(response.status).toBe(503);expect(await response.json()).not.toHaveProperty('items');
 }}finally{log.mockRestore();}
});

test.each([false,true])('temporary session reads preserve retryable failure semantics (combined=%s)',async(combined)=>{
 process.env.DISCOVER_PAGE_INVENTORY_ENABLED=String(combined);
 const table=combined?'discover_page_inventory_v1':'discover_sessions_v1';
 const log=jest.spyOn(console,'error').mockImplementation(()=>{});
 try {
  for(const code of ['57014','22023']) {
   db=createMockClient(op=>op.table===table?{data:null,error:{code,message:'private database detail'}}:respond(op));
   const result=await GET(request('offset=20&limit=20'));
   expect(result.status).toBe(503);
   expect(await result.json()).toEqual({error:'Could not load this feed. Refresh to try again.'});
  }
 } finally {log.mockRestore();}
});
test('batched inventory preserves pagination and fresh moderation without direct table reads',async()=>{
 process.env.DISCOVER_BATCH_INVENTORY_ENABLED='true';
 try {
  ids=['p1','p2','p3']; hidden=new Set(['p1','p2']);
  const body=await (await GET(request('offset=0&limit=2'))).json();
  expect(body.items.map((p:{post_id:string})=>p.post_id)).toEqual(['p3']);
  expect(body.nextOffset).toBe(3);
  expect(db.opsFor('posts')).toHaveLength(0);
  expect(db.opsFor('discover_inventory_batch_v1')).toHaveLength(2);
  banned=true;
  expect((await (await GET(request('offset=0&limit=2'))).json()).items).toEqual([]);
 } finally {delete process.env.DISCOVER_BATCH_INVENTORY_ENABLED;}
});
