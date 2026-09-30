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

  test("OAuth return keeps the same validated video tip intent as email sign-in", () => {
    const next = "/dashboard?postId=5842d226-e9c6-4399-8531-90e076a3be1c&tip=1";
    const redirect = new URL(buildAuthRedirectUrl(
      "https://www.creatornet.net",
      "http://localhost:3000",
      "?next=" + encodeURIComponent(next),
    ));
    expect(redirect.origin).toBe("https://www.creatornet.net");
    expect(redirect.pathname).toBe("/auth");
    expect(redirect.searchParams.get("next")).toBe(next);
  });

  test("OAuth return drops an unrecognized destination", () => {
    expect(buildAuthRedirectUrl(undefined, "http://localhost:3000", "?next=https%3A%2F%2Fevil.test"))
      .toBe("http://localhost:3000/auth");
  });

  test("OAuth return also preserves an existing Profile destination", () => {
    const redirect = new URL(buildAuthRedirectUrl(undefined, "http://localhost:3000", "?next=/profile/edit"));
    expect(redirect.searchParams.get("next")).toBe("/profile/edit");
  });
});
