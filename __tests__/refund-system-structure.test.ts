import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("admin refund system structure", () => {
  test("migration is private, durable, and serializes cumulative allocation", () => {
    const sql = read("supabase/schema/021-admin-refund-operations.sql");
    expect(sql).toContain("create table if not exists public.refund_operations");
    expect(sql).toContain("alter table public.refund_operations enable row level security");
    expect(sql).toContain(
      "revoke all on table public.refund_operations from public, anon, authenticated",
    );
    expect(sql).toContain("create or replace function public.create_refund_operation");
    expect(sql).toContain("for update;");
    expect(sql).toContain("cumulative_customer_refund_target_cents");
    expect(sql).toContain("application_fee_refund_target_cents");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("other.payment_fee_ledger_id = v_row.payment_fee_ledger_id");
    expect(sql).toContain("grant execute on function public.claim_refund_operation");
    expect(sql.trimStart()).toMatch(/^--[\s\S]*\nbegin;/);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });

  test("the server uses destination-charge refund controls and separate fee refunds", () => {
    const source = read("lib/admin/refunds.ts");
    expect(source).toMatch(/reverse_transfer:\s*true/);
    expect(source).toMatch(/refund_application_fee:\s*false/);
    expect(source).toMatch(/applicationFees\.createRefund/);
    expect(source).toMatch(/creatornet:refund:\$\{operation\.id\}:customer/);
    expect(source).toMatch(/application-fee:/);
    expect(source).not.toMatch(/paymentMethods\.create|bankAccounts|externalAccounts\.create/);
  });

  test("admin routes require admin authentication and never expose credentials", () => {
    for (const file of [
      "app/api/admin/refunds/route.ts",
      "app/api/admin/refunds/preview/route.ts",
    ]) {
      const source = read(file);
      expect(source).toMatch(/requireAdmin\(req\)/);
      expect(source).not.toMatch(/STRIPE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY/);
    }
  });

  test("the existing commerce UI owns the refund dialog and deliberate confirmation", () => {
    const page = read("app/admin/commerce/CommercePageClient.tsx");
    const dialog = read("app/admin/commerce/RefundDialog.tsx");
    expect(page).toMatch(/<RefundDialog/);
    expect(dialog).toMatch(/Confirm customer refund/);
    expect(dialog).toMatch(/cannot simply be undone/);
    expect(dialog).toMatch(/Customer receives/);
    expect(dialog).toMatch(/Expected creator balance impact/);
    expect(dialog).toMatch(/from-\[#9370DB\] to-\[#7c5cbf\]/);
    expect(dialog).toMatch(/border-\[#e9e3f7\]/);
  });

  test("webhook remains the authority for business state and confirms exact refund ids", () => {
    const webhook = read("app/api/stripe/webhook/route.ts");
    const refundState = read("lib/paymentRefunds.ts");
    expect(webhook).toMatch(/case "charge\.refunded"/);
    expect(webhook).toMatch(/applyPaymentRefundState\(admin, refundState\)/);
    expect(webhook).toMatch(/confirmAdminRefundWebhookDelivery/);
    expect(refundState).toMatch(/\.in\("stripe_refund_id", ids\)/);
  });

  test("legal pages disclose the refund cost policy without changing their layout", () => {
    expect(read("app/legal/refunds/page.tsx")).toMatch(/complete amount CreatorNet approves/);
    expect(read("app/legal/creators/page.tsx")).toMatch(/offset against future creator earnings/);
    expect(read("app/legal/terms/page.tsx")).toMatch(/does not keep its 12% fee/);
  });
});
