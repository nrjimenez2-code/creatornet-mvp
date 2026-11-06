import "server-only";
import { captureCheckIn, flush } from "@sentry/nextjs";

type Job = "collect" | "recover-exits";
type Env = Record<string, string | undefined>;

/** Wrap only authenticated, server-selected work. Monitor resources and alert
 * routing must be configured and verified before enabling this flag. No monitor
 * upsert is sent here: running a worker must not change schedules or billing. */
export async function monitorMembershipCron(job: Job, work: () => Promise<Response>, env: Env = process.env): Promise<Response> {
  if (env.CREATOR_MONTHLY_MENTORSHIPS_MONITORING_READY !== "true" || env.VERCEL_ENV !== "production") return work();
  const monitorSlug = `creatornet-memberships-${job}`;
  let checkInId: string | undefined;
  let status: "ok" | "error" = "error";
  const started = performance.now();
  // Telemetry is observational. A transport/SDK exception must not prevent or
  // repeat the original financial operation, nor replace its response.
  try { checkInId = captureCheckIn({ monitorSlug, status: "in_progress" }); } catch { /* Missing check-in is monitored externally. */ }
  try {
    const response = await work();
    status = response.ok ? "ok" : "error";
    return response;
  } finally {
    try {
      if (checkInId) captureCheckIn({ monitorSlug, checkInId, status, duration: (performance.now() - started) / 1000 });
      // Bounded flush: no provider identifiers, result bodies, secrets or raw
      // exception messages are included in either check-in.
      await flush(1500);
    } catch { /* Preserve the financial outcome; never retry work here. */ }
  }
}
