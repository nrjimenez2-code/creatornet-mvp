import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin as db } from "@/lib/supabaseAdmin";
import { schedulingAvailable, schedulingOrigin, googleCalendarAvailable } from "@/lib/schedulingConfig";
import { isBookingProvider } from "@/lib/schedulingConnectionTypes";
import { disconnectGoogleCalendar, refreshGoogleCalendarConnection } from "@/lib/googleCalendarConnection";
import { isSchedulingProvider } from "@/lib/schedulingProvider";
import { disconnectSchedulingConnection, refreshSchedulingConnection } from "@/lib/schedulingConnections";

export const runtime = "nodejs";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  try {
    const providers = ["calcom", "calendly", "google"] as const;
    if (process.env.SCHEDULING_OAUTH_ENABLED !== "true" && !googleCalendarAvailable()) return NextResponse.json({ connections: providers.map(provider => ({
      provider, available: false, status: "disconnected", accountName: null, eventTypes: [],
    })) }, { headers });
    let { data: rows, error } = await db.from("scheduling_connections_v1")
      .select("id,provider,status,account_name,last_checked_at").eq("creator_id", user.id);
    if (error) throw error;
    for (const row of rows ?? []) {
      if (((isSchedulingProvider(row.provider) && schedulingAvailable(row.provider)) || (row.provider === "google" && googleCalendarAvailable())) &&
          (row.provider === "google" ? ["connected"] : ["connected", "error", "pending"]).includes(row.status) &&
          (!row.last_checked_at || Date.parse(row.last_checked_at) < Date.now() - 300_000)) {
        try {
          if (row.provider === "google") await refreshGoogleCalendarConnection(user.id);
          else await refreshSchedulingConnection(user.id, row.provider);
        }
        catch {
          const current = await db.from("scheduling_connections_v1").select("status").eq("id", row.id).eq("creator_id", user.id).maybeSingle();
          if (!current.error && current.data?.status === "reconnect_required") continue;
          // A failed health check must not be presented as confirmed connected.
          return NextResponse.json({ error: "Could not verify booking connection" }, { status: 503, headers });
        }
      }
    }
    ({ data: rows, error } = await db.from("scheduling_connections_v1")
      .select("id,provider,status,account_name,last_checked_at").eq("creator_id", user.id));
    if (error) throw error;
    const connections = [];
    for (const provider of providers) {
      const row = rows?.find(value => value.provider === provider);
      let eventTypes: { id: string; title: string; bookingUrl: string }[] = [];
      if (row?.status === "connected" && provider !== "google") {
        const result = await db.from("scheduling_event_types_v1").select("provider_event_id,title,booking_url")
          .eq("connection_id", row.id).eq("active", true).order("title");
        if (result.error) throw result.error;
        eventTypes = (result.data ?? []).map(event => ({ id: event.provider_event_id, title: event.title, bookingUrl: event.booking_url }));
      }
      connections.push({ provider, available: provider === "google" ? googleCalendarAvailable() : schedulingAvailable(provider), status: row?.status ?? "disconnected", accountName: row?.account_name ?? null, eventTypes });
    }
    return NextResponse.json({ connections }, { headers });
  } catch { return NextResponse.json({ error: "Could not load booking connections" }, { status: 503, headers }); }
}

export async function DELETE(req: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  try {
    if (req.headers.get("origin") !== schedulingOrigin()) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
    const { provider } = await req.json();
    if (!isBookingProvider(provider)) return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    if (provider === "google") await disconnectGoogleCalendar(user.id);
    else await disconnectSchedulingConnection(user.id, provider);
    return NextResponse.json({ ok: true }, { headers });
  } catch { return NextResponse.json({ error: "Could not finish disconnecting" }, { status: 503, headers }); }
}
