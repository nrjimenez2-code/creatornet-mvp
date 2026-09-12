import { NextRequest } from "next/server";

jest.mock("@/lib/installments/contextMonthlyCollection", () => ({
  collectContextMonthlyBooking: jest.fn(),
}));
jest.mock("@supabase/supabase-js", () => ({ createClient: jest.fn(() => ({})) }));

import { GET } from "@/app/api/installments/collect/route";
import { collectContextMonthlyBooking } from "@/lib/installments/contextMonthlyCollection";

const worker = jest.mocked(collectContextMonthlyBooking);
const originalSecret = process.env.CRON_SECRET;
const secret = "local-synthetic-scheduler-secret-not-a-real-key";

afterAll(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = secret;
});

describe("#3 monthly collection HTTP authorization", () => {
  it.each([
    undefined,
    "",
    "Bearer wrong-secret",
    `Basic ${secret}`,
    `Bearer ${secret}extra`,
    `Bearer ${"x".repeat(1500)}`,
  ])("rejects unauthorized header %p before invoking the worker", async (authorization) => {
    const request = new NextRequest(
      "http://localhost/api/installments/collect?booking_id=11111111-1111-4111-8111-111111111111",
      { headers: authorization === undefined ? {} : { authorization } }
    );
    const response = await GET(request);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(worker).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(secret);
  });

  it.each([undefined, "", "short-secret"])("fails closed with an unsafe configured secret %p", async (configured) => {
    if (configured === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = configured;
    const response = await GET(new NextRequest("http://localhost/api/installments/collect", {
      headers: { authorization: `Bearer ${configured || ""}` },
    }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(worker).not.toHaveBeenCalled();
  });

  it.each(["nothing_due", "waiting_for_invoice", "credited", "already_credited"])("returns only the successful worker status %s", async status => {
    worker.mockResolvedValue({ status } as Awaited<ReturnType<typeof collectContextMonthlyBooking>>);
    const id = "11111111-1111-4111-8111-111111111111";
    const response = await GET(new NextRequest(`http://localhost/api/installments/collect?booking_id=${id}`, {
      headers: { authorization: `Bearer ${secret}` },
    }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ status });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(worker).toHaveBeenCalledWith(expect.anything(), id, process.env);
  });

  it("returns a bounded retry/review response without leaking provider or secret details", async () => {
    worker.mockRejectedValue(new Error(`Sensitive provider diagnostic ${secret}`));
    const response = await GET(new NextRequest("http://localhost/api/installments/collect?booking_id=invalid", {
      headers: { authorization: `Bearer ${secret}` },
    }));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain(secret);
  });
});
