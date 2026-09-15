import {
  createMockClient,
  type MockClient,
  type Op,
} from "./__mocks__/supabaseQueryMock";
let db: MockClient;
jest.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    return db;
  },
}));
jest.mock("@/lib/supabaseServer", () => ({ createServerClient: () => ({}) }));
import { createDiscoverSession } from "@/lib/discoverServer";
const posts = Array.from({ length: 2005 }, (_, i) => ({
  id: "p" + String(i).padStart(4, "0"),
  creator_id: "c" + String(i).padStart(4, "0"),
  created_at: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString(),
  poster_url: "https://example.test/poster.jpg",
}));
let snapshot: { post_ids: string[]; pilot_id?: string; pilot_variant?: string; pilot_placements?: Record<string,{position:number}> };
function respond(op: Op) {
  if (op.table === "discover_pilots_v1") return {data:{id:"qa",enabled:true,policy_version:"commercial-order-v1",starts_at:"2000-01-01",ends_at:"2100-01-01",eligible_user_ids:["viewer"]},error:null};
  if (op.table === "discover_pilot_assignments_v1") return {data:{variant:"control"},error:null};
  if (op.table === "posts")
    return {
      data: posts
        .filter((p) => p.id > String(op.filters.__gt_id ?? ""))
        .slice(0, 1000),
      error: null,
    };
  if (op.table === "profiles")
    return {
      data: op.inFilters.length
        ? op.inFilters[0].values.map((id) => ({ id, banned_at: null }))
        : { interests: [], interest_topics: [] },
      error: null,
    };
  if (op.table === "follows")
    return {
      data: posts
        .filter(
          (p) => p.creator_id > String(op.filters.__gt_following_id ?? ""),
        )
        .slice(0, 1000)
        .map((p) => ({ following_id: p.creator_id })),
      error: null,
    };
  if (op.table === "discover_sessions_v1") {
    snapshot = op.payload as typeof snapshot;
    return { data: { id: "session" }, error: null };
  }
  return { data: [], error: null };
}
beforeEach(() => {
  db = createMockClient(respond);
  const original = db.from;
  db.from = (table) => {
    const source = original(table);
    return {
      ...source,
      upsert: (payload: unknown) => source.insert(payload),
      select: (columns: string) => {
        const chain = source.select(columns);
        chain.gt = (column: string, value: unknown) =>
          chain.eq("__gt_" + column, value);
        chain.gte = (column: string, value: unknown) =>
          chain.eq("__gte_" + column, value);
        chain.like = (column: string, value: unknown) =>
          chain.eq("__like_" + column, value);
        return chain;
      },
    };
  };
});
test("Following includes more than 1000 followed creators and stays newest-first", async () => {
  await createDiscoverSession("user:viewer", "viewer", "following");
  expect(snapshot.post_ids).toHaveLength(2005);
  expect(snapshot.post_ids[0]).toBe("p2004");
  expect(snapshot.post_ids[2004]).toBe("p0000");
  expect(db.opsFor("follows")).toHaveLength(3);
  expect(db.opsFor("discover_events_v1")).toHaveLength(0);
});
test("Discover fetches only personal history and batches all candidate summaries", async () => {
  await createDiscoverSession("user:viewer", "viewer", "discover");
  expect(snapshot.post_ids).toHaveLength(2005);
  expect(
    db
      .opsFor("discover_events_v1")
      .every((op) => op.filters.actor === "user:viewer"),
  ).toBe(true);
  const batches = db
    .opsFor("discover_rank_evidence_v1")
    .map((op) => (op.payload as { p_posts: string[] }).p_posts);
  expect(batches).toHaveLength(11);
  expect(batches.every((ids) => ids.length <= 200)).toBe(true);
  expect(new Set(batches.flat()).size).toBe(2005);
});

test('only newly minted anonymous identities skip an empty history read', async () => {
  await createDiscoverSession('anon:new',null,'discover',true);
  expect(snapshot.post_ids).toHaveLength(2005);
  expect(db.opsFor('discover_events_v1')).toHaveLength(0);
  await createDiscoverSession('anon:returning',null,'discover');
  await createDiscoverSession('user:viewer','viewer','discover',true);
  expect(db.opsFor('discover_events_v1').map(op=>op.filters.actor)).toEqual(['anon:returning','user:viewer']);
});
test("overlapping sessions share global reads but keep histories and sessions separate", async () => {
  await Promise.all([
    createDiscoverSession("user:alice", "alice", "discover"),
    createDiscoverSession("user:bob", "bob", "discover"),
  ]);
  expect(db.opsFor("posts")).toHaveLength(3);
  expect(db.opsFor("discover_rank_evidence_v1")).toHaveLength(11);
  expect(db.opsFor("discover_events_v1").map(op => op.filters.actor).sort())
    .toEqual(["user:alice", "user:bob"]);
  expect(db.opsFor("discover_sessions_v1")).toHaveLength(2);
  await createDiscoverSession("user:alice", "alice", "discover");
  expect(db.opsFor("posts")).toHaveLength(6);
  expect(db.opsFor("discover_rank_evidence_v1")).toHaveLength(22);
});
test("enabled pilot persists all placement metadata and does not enroll Following",async()=>{
 const previous=process.env.DISCOVER_PILOT_ID;
 process.env.DISCOVER_PILOT_ID="qa";
 try {
  await createDiscoverSession("user:viewer","viewer","discover");
  expect(snapshot.pilot_id).toBe("qa");expect(snapshot.pilot_variant).toBe("control");
  expect(Object.keys(snapshot.pilot_placements!)).toHaveLength(2005);
  snapshot.post_ids.forEach((id,index)=>expect(snapshot.pilot_placements![id].position).toBe(index));
  await createDiscoverSession("user:viewer","viewer","following");
  expect(snapshot.pilot_id).toBeUndefined();expect(snapshot.pilot_placements).toBeUndefined();
 }finally{if(previous===undefined)delete process.env.DISCOVER_PILOT_ID;else process.env.DISCOVER_PILOT_ID=previous;}
});
