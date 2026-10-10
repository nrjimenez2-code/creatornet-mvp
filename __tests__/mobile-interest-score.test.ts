import { NextRequest } from "next/server";

const mockUpdate = jest.fn();
const mockFrom = jest.fn();
let mockMobileUser: { id: string } | null = { id: "signed-in-viewer" };
let mockBrowserUser: { id: string } | null = { id: "browser-viewer" };
let mockDiscover = false;

jest.mock("@/lib/mobileApi", () => ({ mobileApi: (handler: (req: NextRequest, user: typeof mockMobileUser) => Promise<Response>) =>
  (req: NextRequest) => handler(req, mockMobileUser) }));
jest.mock("@/lib/discoverServer", () => ({ discoverEnabled: () => mockDiscover }));
jest.mock("@/lib/updateInterestScore", () => ({ updateInterestScore: (...args: unknown[]) => mockUpdate(...args) }));
jest.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) } }));
jest.mock("@/lib/supabaseServer", () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: mockBrowserUser } }) } }) }));

import { POST as mobilePost } from "@/app/api/mobile/interest-score/route";
import { POST as browserPost } from "@/app/api/interest-score/route";
import { _resetRateLimits } from "@/lib/rateLimit";

const request = (mobile: boolean, body: unknown) => new NextRequest(
  `https://creatornet.net/api/${mobile ? "mobile/" : ""}interest-score`,
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
);

beforeEach(() => {
  mockUpdate.mockReset().mockResolvedValue(undefined);
  mockFrom.mockReset().mockImplementation(() => ({ select: () => ({ eq: () => ({ maybeSingle: async () =>
    ({ data: { interests: ["Money & Investing"] }, error: null }) }) }) }));
  mockMobileUser = { id: "signed-in-viewer" };
  mockBrowserUser = { id: "browser-viewer" };
  mockDiscover = false;
  _resetRateLimits();
});

test("mobile scoring uses the verified actor and the same category rules as the website", async () => {
  const body = { user_id: "other-user", category: "Business & Entrepreneurship", delta: 5 };
  expect((await mobilePost(request(true, body))).status).toBe(200);
  expect(mockUpdate).toHaveBeenCalledWith("signed-in-viewer", "business & entrepreneurship", 5);
  expect((await browserPost(request(false, body))).status).toBe(200);
  expect(mockUpdate).toHaveBeenCalledWith("browser-viewer", "business & entrepreneurship", 5);
});

test("mobile post fallback uses the video's stored primary category", async () => {
  await mobilePost(request(true, { post_id: "video-1", delta: 3 }));
  expect(mockFrom).toHaveBeenCalledWith("posts");
  expect(mockUpdate).toHaveBeenCalledWith("signed-in-viewer", "money & investing", 3);
});

test("anonymous, unknown categories, and unsupported deltas cannot change scores", async () => {
  mockMobileUser = null;
  await mobilePost(request(true, { category: "Business & Entrepreneurship", delta: 5 }));
  mockMobileUser = { id: "signed-in-viewer" };
  await mobilePost(request(true, { category: "unknown", delta: 5 }));
  await mobilePost(request(true, { category: "Business & Entrepreneurship", delta: 1000 }));
  expect(mockUpdate).not.toHaveBeenCalled();
});

test("Discover ranking mode ignores legacy interest writes on both transports", async () => {
  mockDiscover = true;
  expect(await (await mobilePost(request(true, { category: "Business & Entrepreneurship", delta: 5 }))).json())
    .toEqual({ ok: true, ignored: true });
  expect(await (await browserPost(request(false, { category: "Business & Entrepreneurship", delta: 5 }))).json())
    .toEqual({ ok: true, ignored: true });
  expect(mockUpdate).not.toHaveBeenCalled();
});
