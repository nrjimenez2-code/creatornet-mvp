import { NextRequest } from "next/server";

const mockUpdate = jest.fn();
const mockAllow = jest.fn();
let mockMobileUser: { id: string } | null = { id: "mobile-viewer" };
let mockBrowserUser: { id: string } | null = { id: "browser-viewer" };

jest.mock("@/lib/mobileApi", () => ({ mobileApi: (handler: (req: NextRequest, user: typeof mockMobileUser) => Promise<Response>) =>
  (req: NextRequest) => handler(req, mockMobileUser) }));
jest.mock("@/lib/supabaseServer", () => ({ createServerClient: () => ({ auth: { getUser: async () =>
  ({ data: { user: mockBrowserUser } }) } }) }));
jest.mock("@/lib/rateLimit", () => ({ allowRequest: (...args: unknown[]) => mockAllow(...args), clientKey: () => "fixture-ip" }));
jest.mock("@/lib/updatePostMetrics", () => ({
  updatePostMetrics: (...args: unknown[]) => mockUpdate(...args),
  clampWatchSeconds: (value: unknown) => typeof value === "number" && value > 0 ? Math.min(value, 43_200) : 0,
}));

import { POST as mobilePOST } from "@/app/api/mobile/post-metrics/route";
import { POST as browserPOST } from "@/app/api/post-metrics/route";

const request = (mobile: boolean, body: unknown) => new NextRequest(
  `https://creatornet.net/api/${mobile ? "mobile/" : ""}post-metrics`,
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
);
beforeEach(() => {
  mockUpdate.mockReset().mockResolvedValue(undefined);
  mockAllow.mockReset().mockReturnValue(true);
  mockMobileUser = { id: "mobile-viewer" };
  mockBrowserUser = { id: "browser-viewer" };
});

test("mobile and website events attribute the actor from their verified sessions", async () => {
  const body = { post_id: "video-1", field: "views", watch_seconds: 2.5, user_id: "forged" };
  expect((await mobilePOST(request(true, body))).status).toBe(200);
  expect(mockUpdate).toHaveBeenCalledWith("video-1", { views: 1 }, 2.5, "mobile-viewer");
  expect((await browserPOST(request(false, body))).status).toBe(200);
  expect(mockUpdate).toHaveBeenCalledWith("video-1", { views: 1 }, 2.5, "browser-viewer");
});

test("anonymous mobile events use a bounded IP bucket and cannot bump purchases", async () => {
  mockMobileUser = null;
  await mobilePOST(request(true, { post_id: "video-1", field: "impressions", watch_seconds: -2 }));
  expect(mockAllow).toHaveBeenCalledWith("metrics:ip:fixture-ip", expect.objectContaining({ limit: 120 }));
  expect(mockUpdate).toHaveBeenCalledWith("video-1", { impressions: 1 }, 0, null);
  mockUpdate.mockClear();
  await mobilePOST(request(true, { post_id: "video-1", field: "purchases" }));
  await mobilePOST(request(true, { post_id: "video-1", field: "checkout_starts" }));
  expect(mockUpdate).not.toHaveBeenCalled();
});

test("rate limited metrics are acknowledged without writing", async () => {
  mockAllow.mockReturnValue(false);
  expect(await (await mobilePOST(request(true, { post_id: "video-1", field: "views" }))).json())
    .toEqual({ ok: true, limited: true });
  expect(mockUpdate).not.toHaveBeenCalled();
});
