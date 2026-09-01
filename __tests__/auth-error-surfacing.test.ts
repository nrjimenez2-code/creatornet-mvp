/**
 * Tests for lib/authError.ts — the parsing behind surfacing a failed sign-in.
 *
 * Every test here was mutation-checked: the fix was reverted or weakened and the
 * test confirmed to FAIL. The phishing test in particular is the reason this
 * module maps codes to fixed strings instead of echoing the provider.
 */

import {
  parseAuthErrorFromUrl,
  friendlyAuthError,
  urlWithoutAuthError,
  type AuthUrlError,
} from "@/lib/authError";

describe("parseAuthErrorFromUrl", () => {
  it("returns null for a clean URL", () => {
    expect(parseAuthErrorFromUrl("", "")).toBeNull();
    expect(parseAuthErrorFromUrl("?next=/dashboard", "")).toBeNull();
    expect(parseAuthErrorFromUrl(null, undefined)).toBeNull();
  });

  it("reads an error from the query string", () => {
    const e = parseAuthErrorFromUrl("?error=access_denied&error_description=User+said+no", "");
    expect(e).not.toBeNull();
    expect(e!.code).toBe("access_denied");
    expect(e!.description).toBe("User said no");
  });

  it("reads an error from the hash fragment (the implicit flow)", () => {
    const e = parseAuthErrorFromUrl("", "#error=server_error&error_description=boom");
    expect(e!.code).toBe("server_error");
  });

  it("prefers the more specific error_code over error", () => {
    const e = parseAuthErrorFromUrl("?error=server_error&error_code=invalid_client", "");
    expect(e!.code).toBe("invalid_client");
  });

  it("still reports a failure when only a description is present", () => {
    // Silence here would reproduce the original bug for a malformed provider reply.
    const e = parseAuthErrorFromUrl("?error_description=Something+broke", "");
    expect(e).not.toBeNull();
    expect(e!.code).toBeNull();
  });

  it("strips characters that have no business in an error code", () => {
    const e = parseAuthErrorFromUrl("?error=%3Cscript%3Ealert(1)%3C/script%3E", "");
    expect(e!.code).toBe("scriptalert1script");
    expect(e!.code).not.toContain("<");
    expect(e!.code).not.toContain("(");
  });

  it("caps an absurdly long code and description", () => {
    const e = parseAuthErrorFromUrl(
      `?error=${"a".repeat(500)}&error_description=${"b".repeat(5000)}`,
      ""
    );
    expect(e!.code!.length).toBe(64);
    expect(e!.description!.length).toBe(300);
  });

  it("ignores a hash that carries only tokens, not an error", () => {
    expect(parseAuthErrorFromUrl("", "#access_token=abc&expires_in=3600")).toBeNull();
  });
});

describe("friendlyAuthError", () => {
  it("says the user cancelled when they cancelled", () => {
    const msg = friendlyAuthError({ code: "access_denied", description: null });
    expect(msg.toLowerCase()).toContain("cancel");
  });

  it("points at another method when the provider itself is broken", () => {
    for (const code of ["server_error", "invalid_client", "unexpected_failure"]) {
      const msg = friendlyAuthError({ code, description: null });
      expect(msg.toLowerCase()).toMatch(/google|email/);
    }
  });

  it("still says something useful for an unrecognised code", () => {
    const msg = friendlyAuthError({ code: "some_new_code", description: null });
    expect(msg.length).toBeGreaterThan(10);
    expect(msg.toLowerCase()).toContain("try again");
  });

  /**
   * THE PHISHING GUARD. Reverting the fix to `return error.description` makes
   * this fail. A crafted link must never be able to put its own words on our
   * page — a victim reading "call this number" on the real creatornet.net has
   * no way to tell it is not us saying it.
   */
  it("NEVER echoes provider-supplied text back to the page", () => {
    const hostile: AuthUrlError = {
      code: "access_denied",
      description: "Your account is locked. Call 555-0100 to restore access.",
    };
    const msg = friendlyAuthError(hostile);
    expect(msg).not.toContain("555-0100");
    expect(msg).not.toContain("locked");
    expect(msg).not.toContain(hostile.description!);
  });
});

describe("urlWithoutAuthError", () => {
  it("removes every error key so a refresh does not replay the message", () => {
    const next = urlWithoutAuthError(
      "/auth",
      "?error=server_error&error_code=invalid_client&error_description=x&error_uri=y",
      ""
    );
    expect(next).toBe("/auth");
  });

  it("keeps parameters that are not about the error", () => {
    const next = urlWithoutAuthError("/auth", "?next=%2Flibrary&error=access_denied", "");
    expect(next).toBe("/auth?next=%2Flibrary");
  });

  it("cleans the hash too", () => {
    const next = urlWithoutAuthError("/auth", "", "#error=server_error&error_description=x");
    expect(next).toBe("/auth");
  });

  it("leaves an already-clean URL alone", () => {
    expect(urlWithoutAuthError("/auth", "", "")).toBe("/auth");
  });
});
