const requireAdminMock = jest.fn();

jest.mock("@/lib/admin/server", () => ({
  requireAdmin: (...args: unknown[]) => requireAdminMock(...args),
  adminAuthErrorResponse: () =>
    new Response(JSON.stringify({ error: "Not signed in" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
}));
jest.mock("@/lib/admin/refund-store", () => ({
  createSupabaseRefundStore: jest.fn(() => ({})),
}));
jest.mock("@/lib/stripeClient", () => ({ getStripe: jest.fn(() => ({})) }));
jest.mock("@/lib/admin/refunds", () => {
  class RefundWorkflowError extends Error {
    status = 400 as const;
  }
  return {
    RefundWorkflowError,
    createAndProcessAdminRefund: jest.fn(),
    processRefundOperation: jest.fn(),
    publicRefundOperation: jest.fn(),
    previewAdminRefund: jest.fn(),
  };
});

function request(path: string, body: unknown, origin = "https://www.creatornet.net") {
  return new Request(`https://www.creatornet.net${path}`, {
    method: "POST",
    headers: {
      host: "www.creatornet.net",
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => jest.clearAllMocks());

describe("admin refund API boundary", () => {
  test("cross-origin refund attempts are refused before authentication", async () => {
    const { POST } = await import("@/app/api/admin/refunds/route");
    const response = await POST(
      request("/api/admin/refunds", {}, "https://attacker.example") as never,
    );
    expect(response.status).toBe(403);
    expect(requireAdminMock).not.toHaveBeenCalled();
  });

  test("same-origin unauthenticated refund attempts are refused", async () => {
    requireAdminMock.mockRejectedValueOnce(new Error("not signed in"));
    const { POST } = await import("@/app/api/admin/refunds/route");
    const response = await POST(request("/api/admin/refunds", {}) as never);
    expect(response.status).toBe(401);
  });

  test("confirmation totals are required instead of silently bypassing preview", async () => {
    requireAdminMock.mockResolvedValueOnce({
      user: { id: "admin" },
      admin: {},
    });
    const { POST } = await import("@/app/api/admin/refunds/route");
    const response = await POST(
      request("/api/admin/refunds", {
        paymentFeeLedgerId: "22222222-2222-4222-8222-222222222222",
        amountCents: 100,
      }) as never,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/Review the current refund totals/),
    });
  });
});
