import { sendReportEmail } from "@/lib/admin/reportEmail";

const input = {
  reportId: "22222222-2222-4222-8222-222222222222",
  postId: "11111111-1111-4111-8111-111111111111",
  title: "Video\nForged heading",
  reason: "spam" as const,
};
const previous = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_CODE_FROM: process.env.EMAIL_CODE_FROM,
  REPORT_NOTIFICATION_EMAIL: process.env.REPORT_NOTIFICATION_EMAIL,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  jest.restoreAllMocks();
});

test("an alert uses the CreatorNet support inbox by default", async () => {
  process.env.RESEND_API_KEY = "test-key";
  process.env.EMAIL_CODE_FROM = "CreatorNet <no-reply@example.invalid>";
  delete process.env.REPORT_NOTIFICATION_EMAIL;
  const fetcher = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true } as Response);
  expect(await sendReportEmail(input)).toBe(true);
  const body = JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body));
  expect(body.to).toEqual(["support@creatornet.net"]);
});

test("without the existing sender configuration it does not call the email provider", async () => {
  delete process.env.RESEND_API_KEY;
  process.env.EMAIL_CODE_FROM = "CreatorNet <no-reply@example.invalid>";
  delete process.env.REPORT_NOTIFICATION_EMAIL;
  const fetcher = jest.spyOn(global, "fetch");
  const logging = jest.spyOn(console, "error").mockImplementation(() => {});
  expect(await sendReportEmail(input)).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
  expect(logging).toHaveBeenCalled();
});

test("an alert uses the configured inbox and links directly to admin review", async () => {
  process.env.RESEND_API_KEY = "test-key";
  process.env.EMAIL_CODE_FROM = "CreatorNet <no-reply@example.invalid>";
  process.env.REPORT_NOTIFICATION_EMAIL = "moderation@example.invalid";
  process.env.NEXT_PUBLIC_SITE_URL = "https://www.creatornet.net";
  const fetcher = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true } as Response);
  expect(await sendReportEmail(input)).toBe(true);
  const body = JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body));
  expect(body.to).toEqual(["moderation@example.invalid"]);
  expect(body.text).toContain(`/admin/content?report=${input.reportId}`);
  expect(body.text).toContain("Video Forged heading");
});
