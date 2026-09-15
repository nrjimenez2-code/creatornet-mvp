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
  if(op.table === 'discover_page_inventory_v1') {
    const args=op.payload as {p_actor:string;p_offset:number;p_limit:number};
    if(args.p_actor!==actor || expired) return {data:null,error:{code:'22023'}};
    const selected=ids.slice(args.p_offset,args.p_offset+args.p_limit);
    return {data:{post_ids:ids,expires_at:new Date(Date.now()+3600000).toISOString(),
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
  delete process.env.DISCOVER_PAGE_INVENTORY_ENABLED;
  delete process.env.DISCOVER_V4_ENABLED;
});
const request = (query: string) =>
  new NextRequest("https://example.test/api/feed?session=existing&" + query);
test("pagination crosses the old 2000 cap and keeps snapshot order", async () => {
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
    expect((await GET(request("offset=0"))).status).toBe(503);
    actor = "user:viewer";
    expired = true;
    expect((await GET(request("offset=0"))).status).toBe(503);
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
test('combined page path preserves moderation skipping, ownership and expiry',async()=>{
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
  expect((await GET(request('offset=0&limit=5'))).status).toBe(503);
  actor='user:viewer'; expired=true;
  expect((await GET(request('offset=0&limit=5'))).status).toBe(503);
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
