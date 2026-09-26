import { NextRequest } from "next/server";
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";
import { _resetRateLimits } from "@/lib/rateLimit";
let db: MockClient, user: { id: string } | null;
jest.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: { from: (t: string) => db.from(t), rpc: (n: string,a: unknown) => db.rpc(n,a) } }));
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: async () => user }));
import { POST } from "@/app/api/posts/view-counts/route";
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12,"0")}`;
let rows: Array<Record<string,unknown>>, purchases: Array<Record<string,unknown>>, profiles: Array<Record<string,unknown>>, readError: boolean;
beforeEach(() => {
  _resetRateLimits(); user = null; readError = false;
  rows = [1,2,3,4,5,6].map(i => ({ id: id(i), creator_id: "creator", video_url: "video.mp4", active: true, hidden_at: null, removed_at: null }));
  rows[1].hidden_at = "date"; rows[2].removed_at = "date"; rows[3].active = false; rows[4].video_url = null;
  rows[5].creator_id = "banned";
  profiles = [{ id: "creator", banned_at: null, username: "creator" }, { id: "banned", banned_at: "date", username: "banned" }];
  purchases = [];
  db = createMockClient(op => {
    if(op.table === "posts") return { data: rows, error: readError ? {} : null };
    if(op.table === "profiles") return { data: profiles, error: null };
    if(op.table === "purchases") return { data: purchases, error: null };
    if(op.table === "get_post_view_counts_v1") return { data: (op.payload as {p_post_ids:string[]}).p_post_ids.map(post_id => ({ post_id, view_count: 1395 })), error: null };
    if(op.kind === "rpc") return { data: { applicable: true, allowed: true, maxAgeSeconds: 10 }, error: null };
    return undefined;
  });
});
const request = (postIds: unknown = rows.map(row => row.id)) => POST(new NextRequest("https://site.invalid/api/posts/view-counts", { method:"POST",body:JSON.stringify({ postIds, buyer_id:"creator" }) }));
test("anonymous ids expose only public published videos and counts, never identities/events", async () => {
  const res = await request();
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(await res.json()).toEqual({ items:[{ post_id:id(1),view_count:1395 }] });
  expect(db.opsFor("get_post_view_counts_v1")[0].payload).toEqual({ p_post_ids:[id(1)] });
  expect(db.opsFor("purchases")).toHaveLength(0);
  expect(db.ops.every(op => op.kind === "select" || op.kind === "rpc")).toBe(true);
});
test("creator may read their own hidden/inactive post, with no removed or nonvideo post", async () => {
  user = { id:"creator" };
  expect((await (await request()).json()).items.map((item: {post_id:string}) => item.post_id)).toEqual([id(1),id(2),id(4)]);
});
test("eligible Library access permits moderated posts and is bound to the authenticated buyer", async () => {
  user = { id:"buyer" };
  purchases = [{ id:"paid",post_id:id(3),buyer_id:"buyer",status:"paid",access_granted:true },
    { id:"forged",post_id:id(2),buyer_id:"other",status:"paid",access_granted:true },
    { id:"refunded",post_id:id(4),buyer_id:"buyer",status:"refunded",access_granted:true }];
  expect((await (await request()).json()).items.map((item: {post_id:string}) => item.post_id)).toEqual([id(1),id(3)]);
  expect(db.opsFor("purchases")[0].filters.buyer_id).toBe("buyer");
});
test.each([null,["not-a-uuid"],Array(101).fill(id(1))])("invalid ids %p never reach storage", async postIds => {
  expect((await request(postIds)).status).toBe(400); expect(db.ops).toHaveLength(0);
});
test("unknown ids are omitted and failed authorization reads are errors", async () => {
  expect(await (await request([id(99)])).json()).toEqual({items:[]});
  readError = true; expect((await request()).status).toBe(503);
});
