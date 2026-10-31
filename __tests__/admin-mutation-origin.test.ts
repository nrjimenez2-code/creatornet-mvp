import { NextRequest } from "next/server";

const mockRequireAdmin = jest.fn();
const mockFrom = jest.fn();
const mockSendEmail = jest.fn();
jest.mock("@/lib/admin/server", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
  adminAuthErrorResponse: () => Response.json({ error: "Not signed in" }, { status: 401 }),
}));
jest.mock("@/lib/admin/reportEmail", () => ({ sendReportEmail: (...args: unknown[]) => mockSendEmail(...args) }));
jest.mock("@/lib/admin/reports", () => ({ fetchAdminReportById: jest.fn() }));

import { runModerationAction, deriveUserStatus } from "@/lib/admin/moderation";
import { POST as removeReview } from "@/app/api/admin/remove-review/route";
import { POST as reviewReport } from "@/app/api/admin/reports/[reportId]/route";
import { POST as notifyReport } from "@/app/api/admin/reports/[reportId]/notify/route";

const params = { params: Promise.resolve({ reportId: "22222222-2222-4222-8222-222222222222" }) };
const handlers = {
  moderation: (req: NextRequest) => runModerationAction(req, {
    action: "ban_user", targetTable: "profiles", bodyKey: "userId", selectColumns: "banned_at,flag_reason",
    buildUpdate: () => ({ banned_at: "2026-10-22T00:00:00Z" }), deriveStatus: deriveUserStatus,
  }),
  removeReview,
  reviewReport: (req: NextRequest) => reviewReport(req, params),
  notifyReport: (req: NextRequest) => notifyReport(req, params),
};
beforeEach(() => {
  jest.clearAllMocks();
  mockRequireAdmin.mockRejectedValue(Error("signed-out fixture"));
});

test("same-origin admin moderation retains its update and audit", async () => {
  const audit = jest.fn().mockResolvedValue({ error: null });
  const update = jest.fn().mockReturnValue({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: { banned_at: "2026-10-22T00:00:00Z", flag_reason: null }, error: null }) }) }) });
  mockFrom.mockImplementation((table: string) => table === "profiles" ? { update } : { insert: audit });
  mockRequireAdmin.mockResolvedValue({ user: { id: "admin-fixture" }, admin: { from: mockFrom } });
  const req = new NextRequest("https://www.creatornet.net/api/admin/ban", {
    method: "POST", headers: { host: "www.creatornet.net", origin: "https://www.creatornet.net" }, body: JSON.stringify({ userId: "target" }),
  });
  expect((await handlers.moderation(req)).status).toBe(200);
  expect(update).toHaveBeenCalledTimes(1);
  expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "ban_user", target_id: "target", actor_id: "admin-fixture" }));
});

describe.each(Object.entries(handlers))("%s mutation origin", (_name, handler) => {
  test.each([undefined, "null", "https://evil.example", "https://media.creatornet.net"])("rejects %s before auth, DB, or email", async origin => {
    // text/plain makes this a simple browser request; CORS alone cannot stop it.
    const req = new NextRequest("https://www.creatornet.net/api/admin/fixture", {
      method: "POST", headers: { host: "www.creatornet.net", "Content-Type": "text/plain", ...(origin ? { origin } : {}) },
      body: JSON.stringify({ userId: "target", reviewId: "target", status: "reviewed" }),
    });
    expect((await handler(req)).status).toBe(403);
    expect(mockRequireAdmin).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test("same-origin request still passes through the admin authorization gate", async () => {
    const req = new NextRequest("https://www.creatornet.net/api/admin/fixture", {
      method: "POST", headers: { host: "www.creatornet.net", origin: "https://www.creatornet.net" },
    });
    expect((await handler(req)).status).toBe(401);
    expect(mockRequireAdmin).toHaveBeenCalledWith(req);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
