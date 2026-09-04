import { buildAuthRedirectUrl } from "@/lib/authRedirect";

describe("buildAuthRedirectUrl", () => {
  test("uses the configured production www host for every auth method", () => {
    expect(
      buildAuthRedirectUrl(
        "https://www.creatornet.net",
        "http://localhost:3000",
      ),
    ).toBe("https://www.creatornet.net/auth");
  });

  test("normalizes a trailing slash without duplicating the auth path", () => {
    expect(
      buildAuthRedirectUrl(
        "https://www.creatornet.net/",
        "http://localhost:3000",
      ),
    ).toBe("https://www.creatornet.net/auth");
  });

  test("uses the current origin when no site URL is configured", () => {
    expect(buildAuthRedirectUrl(undefined, "http://localhost:3000")).toBe(
      "http://localhost:3000/auth",
    );
  });

  test("rejects non-web redirect schemes", () => {
    expect(() =>
      buildAuthRedirectUrl("javascript:alert(1)", "http://localhost:3000"),
    ).toThrow("must use HTTP or HTTPS");
  });
});
