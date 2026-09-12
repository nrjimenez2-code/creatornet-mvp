import { NextRequest, NextResponse } from "next/server";
import { adminAuthErrorResponse, requireAdmin } from "@/lib/admin/server";
import { exactAdminEnabled, parseExactStopInput, readExactAdminPage, stopExactAdminBilling } from "@/lib/installments/adminActions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store", "Vary": "Cookie, Authorization" },
});

export async function GET(req: NextRequest) {
  let context: Awaited<ReturnType<typeof requireAdmin>>;
  try { context = await requireAdmin(req); }
  catch (err) { return adminAuthErrorResponse(err, "read_installments"); }
  if (!exactAdminEnabled(process.env)) return json({ error: "Installment review is not enabled." }, 404);
  const cursor = req.nextUrl.searchParams.get("after");
  if (cursor !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor)) {
    return json({ error: "Invalid review page." }, 400);
  }
  try { return json(await readExactAdminPage(context.admin, context.user.id, cursor, process.env)); }
  catch { return json({ error: "Installment review could not be loaded. No action was taken." }, 503); }
}

export async function POST(req: NextRequest) {
  // Pin BOTH browser Origin and route origin to trusted server configuration.
  // A forged forwarded-host header cannot authorize a cross-site stop request.
  if (req.headers.get("origin") !== process.env.NEXT_PUBLIC_SITE_URL ||
    req.nextUrl.origin !== process.env.NEXT_PUBLIC_SITE_URL) return json({ error: "Invalid request origin." }, 403);
  let context: Awaited<ReturnType<typeof requireAdmin>>;
  try { context = await requireAdmin(req); }
  catch (err) { return adminAuthErrorResponse(err, "stop_installment_billing"); }
  if (!exactAdminEnabled(process.env)) return json({ error: "Installment billing controls are not enabled." }, 404);
  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const input = parseExactStopInput(body);
  if (!input) return json({ error: "Confirm the exact plan and stop request before continuing." }, 400);
  try {
    const result = await stopExactAdminBilling(context.admin, context.user.id, input, process.env);
    return json({ status: result.status }, result.status === "collection_stopped" ? 200 : 202);
  } catch {
    // The durable hold or external stop may already exist. Never claim that an
    // error means nothing happened, expose raw errors, or generate a new request.
    return json({ error: "The stop needs review. Refresh this plan before retrying the same request." }, 409);
  }
}
