import { NextRequest, NextResponse } from "next/server";
import { verifySchedulingSignature } from "@/lib/schedulingWebhook";
import { supabaseAdmin as admin } from "@/lib/supabaseAdmin";
import { discoverEnabled } from "@/lib/discoverServer";
type Connection = {
  id: string;
  provider: "calendly" | "calcom";
  creatorId: string;
  eventType: string;
  secret: string;
};
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ connection: string }> },
) {
  if (!discoverEnabled())
    return NextResponse.json({ error: "Not enabled" }, { status: 503 });
  try {
    const { connection } = await params;
    const configurations = JSON.parse(
      process.env.DISCOVER_SCHEDULING_CONNECTIONS ?? "[]",
    ) as Connection[];
    const config = configurations.find((c) => c.id === connection);
    if (!config)
      return NextResponse.json(
        { error: "Unknown connection" },
        { status: 404 },
      );
    const raw = await req.text();
    if (raw.length > 262144)
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    const header =
      req.headers.get(
        config.provider === "calendly"
          ? "calendly-webhook-signature"
          : "x-cal-signature-256",
      ) ?? "";
    if (!verifySchedulingSignature(config.provider, raw, header, config.secret))
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    const event = JSON.parse(raw);
    const p = event.payload;
    if (!p) return NextResponse.json({ ok: true, ignored: true });
    const isCalendly = config.provider === "calendly";
    const kind = isCalendly ? event.event : event.triggerEvent;
    const canceled =
      kind === (isCalendly ? "invitee.canceled" : "BOOKING_CANCELLED");
    if (
      !canceled &&
      kind !== (isCalendly ? "invitee.created" : "BOOKING_CREATED") &&
      kind !== "BOOKING_RESCHEDULED"
    )
      return NextResponse.json({ ok: true, ignored: true });
    const eventType = isCalendly
      ? p.scheduled_event?.event_type
      : String(p.eventTypeId);
    if (eventType !== config.eventType)
      return NextResponse.json({ ok: true, ignored: true });
    if (!isCalendly && !canceled && p.status !== "ACCEPTED")
      return NextResponse.json({ ok: true, ignored: true });
    const token = isCalendly
      ? p.tracking?.utm_content
      : p.metadata?.cn_attribution;
    const attributionId =
      typeof token === "string" ? token.replace(/^cn_/, "") : "";
    if (!/^[a-f0-9-]{36}$/.test(attributionId))
      return NextResponse.json({ ok: true, unattributed: true });
    const { data: a, error } = await admin
      .from("discover_booking_attribution_v1")
      .select("user_id,creator_id")
      .eq("id", attributionId)
      .single();
    if (error || a?.creator_id !== config.creatorId)
      return NextResponse.json(
        { error: "Attribution mismatch" },
        { status: 403 },
      );
    const { data: user, error: userError } = await admin.auth.admin.getUserById(
      a.user_id,
    );
    if (userError) throw userError;
    const emails = isCalendly
      ? [p.email]
      : (p.attendees ?? []).map((v: { email?: string }) => v.email);
    if (
      !user.user?.email ||
      !emails.some(
        (email: unknown) =>
          typeof email === "string" &&
          email.toLowerCase() === user.user.email!.toLowerCase(),
      )
    )
      return NextResponse.json({ ok: true, unattributed: true });
    const booking = isCalendly ? p.uri : p.uid;
    const eventAt = isCalendly ? event.created_at : event.createdAt;
    const start = isCalendly ? p.scheduled_event?.start_time : p.startTime;
    if (
      typeof booking !== "string" ||
      !Number.isFinite(Date.parse(eventAt)) ||
      (!canceled && !Number.isFinite(Date.parse(start)))
    )
      return NextResponse.json(
        { error: "Incomplete booking" },
        { status: 400 },
      );
    const { error: saveError } = await admin.rpc(
      "confirm_discover_booking_v1",
      {
        p_attribution: attributionId,
        p_provider: config.provider,
        p_booking: booking,
        p_event_at: eventAt,
        p_scheduled_at: start ?? null,
        p_canceled: canceled,
      },
    );
    if (saveError) throw saveError;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Scheduling confirmation unavailable" },
      { status: 503 },
    );
  }
}
