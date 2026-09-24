import { NextRequest } from "next/server";

const mockRequireAdmin = jest.fn();
const mockUpdate = jest.fn();
const mockAudit = jest.fn();
const mockFetchReport = jest.fn();

jest.mock("@/lib/admin/server", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
  adminAuthErrorResponse: () => Response.json({ error: "Not signed in" }, { status: 401 }),
}));
jest.mock("@/lib/admin/reports", () => ({ fetchAdminReportById: (...args: unknown[]) => mockFetchReport(...args) }));

import { GET, POST } from "@/app/api/admin/reports/[reportId]/route";

const id = "22222222-2222-4222-8222-222222222222";
const params = { params: Promise.resolve({ reportId: id }) };
const request = (method: string, body?: unknown) => new NextRequest(`http://localhost/api/admin/reports/${id}`, {
  method, ...(body ? { body: JSON.stringify(body) } : {}),
});

beforeEach(() => {
  mockRequireAdmin.mockReset().mockResolvedValue({
    user: { id: "admin-id" },
    admin: { from: (table: string) => table === "post_reports" ? {
      update: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => mockUpdate() }) }) }),
    } : { insert: (...args: unknown[]) => mockAudit(...args) } },
  });
  mockUpdate.mockReset().mockResolvedValue({ data: { id }, error: null });
  mockAudit.mockReset().mockResolvedValue({ error: null });
  mockFetchReport.mockReset().mockResolvedValue({ id, postTitle: "Reported video" });
});

test("a non-admin cannot read report details", async () => {
  mockRequireAdmin.mockRejectedValue(Error("not admin"));
  expect((await GET(request("GET"), params)).status).toBe(401);
  expect(mockFetchReport).not.toHaveBeenCalled();
});

test("admin can mark a report reviewed and the action is audited", async () => {
  const response = await POST(request("POST", { status: "reviewed" }), params);
  expect(response.status).toBe(200);
  expect(mockUpdate).toHaveBeenCalledTimes(1);
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "reviewed_report", target_id: id }));
});

test("unrecognized status is rejected before a write", async () => {
  expect((await POST(request("POST", { status: "approved" }), params)).status).toBe(400);
  expect(mockUpdate).not.toHaveBeenCalled();
});
