const mockCheckIn = jest.fn(), mockFlush = jest.fn();
jest.mock("@sentry/nextjs", () => ({ captureCheckIn: (...args: unknown[]) => mockCheckIn(...args), flush: (...args: unknown[]) => mockFlush(...args) }));
import { monitorMembershipCron } from "@/lib/membershipCronMonitor";
const env = { VERCEL_ENV: "production", CREATOR_MONTHLY_MENTORSHIPS_MONITORING_READY: "true" };
beforeEach(() => { jest.resetAllMocks(); mockCheckIn.mockReturnValue("check-in-id"); mockFlush.mockResolvedValue(true); });
test.each([200, 503])("HTTP %s determines monitor outcome, including handled batch errors", async code => {
  const response = Response.json({ privateProviderId: "must-not-be-sent" }, { status: code });
  const work = jest.fn().mockResolvedValue(response);
  expect(await monitorMembershipCron("collect", work, env)).toBe(response);
  expect(work).toHaveBeenCalledTimes(1);
  expect(mockCheckIn).toHaveBeenNthCalledWith(1, { monitorSlug: "creatornet-memberships-collect", status: "in_progress" });
  expect(mockCheckIn).toHaveBeenNthCalledWith(2, expect.objectContaining({ checkInId: "check-in-id", status: code === 200 ? "ok" : "error" }));
  expect(JSON.stringify(mockCheckIn.mock.calls)).not.toContain("must-not-be-sent");
  expect(mockFlush).toHaveBeenCalledWith(1500);
});
test("a thrown operation remains the original exception and records error without its private message", async () => {
  const error = Error("private-provider-details");
  const work = jest.fn().mockRejectedValue(error);
  await expect(monitorMembershipCron("recover-exits", work, env)).rejects.toBe(error);
  expect(work).toHaveBeenCalledTimes(1);
  expect(mockCheckIn).toHaveBeenLastCalledWith(expect.objectContaining({ monitorSlug: "creatornet-memberships-recover-exits", status: "error" }));
  expect(JSON.stringify(mockCheckIn.mock.calls)).not.toContain(error.message);
});
test.each(["start", "finish", "flush"])("telemetry failure at %s never repeats work or replaces its result", async point => {
  if (point === "start") mockCheckIn.mockImplementationOnce(() => { throw Error("offline"); });
  if (point === "finish") mockCheckIn.mockReturnValueOnce("id").mockImplementationOnce(() => { throw Error("offline"); });
  if (point === "flush") mockFlush.mockRejectedValueOnce(Error("offline"));
  const response = new Response(null, { status: 503 });
  const work = jest.fn().mockResolvedValue(response);
  expect(await monitorMembershipCron("collect", work, env)).toBe(response);
  expect(work).toHaveBeenCalledTimes(1);
});
test.each([{}, { ...env, VERCEL_ENV: "preview" }, { ...env, CREATOR_MONTHLY_MENTORSHIPS_MONITORING_READY: "false" }])(
  "unconfigured/local/preview execution cannot heartbeat the production monitor", async settings => {
    const work = jest.fn().mockResolvedValue(new Response());
    await monitorMembershipCron("collect", work, settings);
    expect(work).toHaveBeenCalledTimes(1); expect(mockCheckIn).not.toHaveBeenCalled(); expect(mockFlush).not.toHaveBeenCalled();
  });
