import { membershipCheckoutReady, membershipServerContext } from "@/lib/membershipServer";
import { membershipTestContext as context, membershipTestEnv } from "../test-support/membership-fixtures";
const configuration = () => ({ ...membershipTestEnv, CREATOR_MONTHLY_MENTORSHIPS_CONTEXT: JSON.stringify(context),
  VERCEL_ENV: "preview", NEXT_PUBLIC_SUPABASE_URL: `https://${context.supabaseProjectRef}.supabase.co`,
  NEXT_PUBLIC_SITE_URL: context.siteOrigin, SUPABASE_SERVICE_ROLE_KEY: "synthetic-not-a-credential",
  STRIPE_SECRET_KEY: "sk_test_fixture", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_fixture" });
test("step 10: approved-style preview configuration is parsed without contacting either provider", () => {
  expect(membershipServerContext(configuration())).toEqual(context); expect(membershipCheckoutReady(configuration())).toBe(true);
});
test.each(Object.keys(membershipTestEnv).filter(key => key.endsWith("READY") || key.endsWith("APPROVED")))(
  "steps 1/9/10: missing prerequisite %s disables new checkout", key => {
    expect(membershipCheckoutReady({ ...configuration(), [key]: "false" })).toBe(false);
  });
test.each([
  { VERCEL_ENV: "development" }, { NEXT_PUBLIC_SITE_URL: "https://other.vercel.app" },
  { STRIPE_SECRET_KEY: "sk_live_fixture" }, { NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_fixture" },
  { NEXT_PUBLIC_SUPABASE_URL: "https://rvkqxgghqitkwzdsuclz.supabase.co" }, { SUPABASE_SERVICE_ROLE_KEY: "" },
  { CREATOR_MONTHLY_MENTORSHIPS_CONTEXT: JSON.stringify({ ...context, apiVersion: "2025-09-30.clover" }) },
  { CREATOR_MONTHLY_MENTORSHIPS_CONTEXT: JSON.stringify({ ...context, extra: true }) },
])("step 10: mixed or incomplete context %p fails closed", change => {
  expect(() => membershipServerContext({ ...configuration(), ...change })).toThrow();
});
