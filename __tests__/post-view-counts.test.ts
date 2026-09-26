import { formatViewCount, normalizeViewCount, viewCountLabel } from "@/lib/postViewCounts";
import { enrichPostViewCounts, readPostViewCounts } from "@/lib/postViewCountsServer";
import { loadPostViewCounts } from "@/lib/postViewCountsClient";
import type { SupabaseClient } from "@supabase/supabase-js";

test.each([[0,"0"],[724,"724"],[1395,"1,395"],[9999,"9,999"],[10000,"10K"],[27100,"27.1K"],[1200000,"1.2M"],[null,"—"]])("formats %p as %s", (count, expected) => {
  expect(formatViewCount(count as number | null)).toBe(expected);
});
test("full recorded counts are accessible and malformed values stay unavailable", () => {
  expect(viewCountLabel(27100)).toBe("27,100 views");
  expect(viewCountLabel(1)).toBe("1 view");
  expect(viewCountLabel(null)).toBe("Views unavailable");
  for (const value of [null,undefined,"",-1,1.5,"bad",Infinity,Number.MAX_SAFE_INTEGER+1]) expect(normalizeViewCount(value)).toBeNull();
  expect(normalizeViewCount("1395")).toBe(1395);
});
test("server enrichment preserves order, batches and deduplicates ids, and does no writes", async () => {
  const rpc = jest.fn(async (_name: string, args: { p_post_ids: string[] }) => ({ data: args.p_post_ids.map(post_id => ({ post_id, view_count: post_id === "p0" ? "0" : "1395" })), error: null }));
  const admin = { rpc } as unknown as SupabaseClient;
  const posts = [...Array.from({ length: 205 }, (_, i) => ({ id: `p${i}`, title: `Post ${i}` })), { id: "p0", title: "duplicate" }];
  const enriched = await enrichPostViewCounts(admin, posts);
  expect(rpc.mock.calls.map(call => call[1].p_post_ids.length)).toEqual([100,100,5]);
  expect(rpc.mock.calls.every(call => call[0] === "get_post_view_counts_v1")).toBe(true);
  expect(enriched.map(post => post.id)).toEqual(posts.map(post => post.id));
  expect(enriched[0].view_count).toBe(0); expect(enriched[1].view_count).toBe(1395);
  expect(enriched.at(-1)?.view_count).toBe(0);
});
test("reader failures, missing rows and invalid counts never become zero", async () => {
  const log = jest.spyOn(console,"warn").mockImplementation(() => {});
  const rpc = jest.fn().mockResolvedValueOnce({ data: null, error: {} }).mockResolvedValueOnce({ data: [{ post_id: "p100", view_count: -1 }, { post_id: "not-requested", view_count: 5 }], error: null });
  const counts = await readPostViewCounts({ rpc } as unknown as SupabaseClient, Array.from({ length: 102 }, (_, i) => `p${i}`));
  expect([...counts.values()].every(count => count === null)).toBe(true);
  expect(counts.has("not-requested")).toBe(false); log.mockRestore();
});
test("client batches only on reload and reads counts without event writes or retry loops", async () => {
  const fetchMock = jest.fn().mockImplementation(async (_url, init) => ({ ok: true, json: async () => ({ items: JSON.parse(init.body).postIds.map((post_id: string) => ({ post_id, view_count: 0 })) }) }));
  global.fetch = fetchMock;
  const counts = await loadPostViewCounts(Array.from({ length: 201 }, (_, i) => `p${i}`));
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls.every(([url,init]) => url === "/api/posts/view-counts" && init.cache === "no-store" && init.credentials === "include")).toBe(true);
  expect(counts.get("p0")).toBe(0);
  fetchMock.mockReset().mockRejectedValue(Error("offline"));
  expect((await loadPostViewCounts(["p0"])).get("p0")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
test("Library purchase references stay within their matching count batch", async () => {
  const ids = Array.from({length:101},(_,i)=>`post-${i}`);
  const purchaseIdByPost = new Map([...ids.map((id,i)=>[id,`purchase-${i}`] as const),["unloaded","unrelated"]]);
  const fetchMock = jest.fn().mockResolvedValue({ok:true,json:async()=>({items:[]})});
  global.fetch = fetchMock;
  await loadPostViewCounts(ids,{purchaseIdByPost});
  const payloads = fetchMock.mock.calls.map(([,init])=>JSON.parse(init.body));
  expect(payloads.map(p=>p.purchaseIds.length)).toEqual([100,1]);
  expect(payloads[1]).toEqual({postIds:["post-100"],purchaseIds:["purchase-100"]});
  expect(payloads[0].purchaseIds).not.toContain("unrelated");
});
