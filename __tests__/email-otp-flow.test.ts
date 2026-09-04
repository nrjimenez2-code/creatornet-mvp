import { readFileSync } from "fs";
import { join } from "path";

const authPage = readFileSync(
  join(__dirname, "..", "app", "auth", "page.tsx"),
  "utf8",
);

describe("passwordless email code flow", () => {
  test("requests an email OTP without introducing passwords", () => {
    expect(authPage).toMatch(/signInWithOtp\(\{/);
    expect(authPage).toMatch(/shouldCreateUser:\s*true/);
    expect(authPage).not.toMatch(/signInWithPassword|resetPasswordForEmail/);
  });

  test("verifies a six-digit email token", () => {
    expect(authPage).toMatch(/verifyOtp\(\{[\s\S]*type:\s*["']email["']/);
    expect(authPage).toMatch(/\^\\d\{6\}\$/);
  });

  test("exposes mobile-friendly one-time-code controls", () => {
    expect(authPage).toMatch(/autoComplete="one-time-code"/);
    expect(authPage).toMatch(/inputMode="numeric"/);
    expect(authPage).toMatch(/Resend code in/);
  });
});
