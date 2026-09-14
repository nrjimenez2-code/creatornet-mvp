"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useUser } from "@/lib/useUser";
import { BOOKING_PROVIDER_NAMES, type BookingConnectionStatus, type BookingProvider } from "@/lib/schedulingConnectionTypes";

type Props = {
  purpose?: "session" | "sales-call";
  value?: string;
  onSelect?: (url: string) => void;
};

export default function SchedulingConnections({ purpose, value, onSelect }: Props) {
  const { userId, session, loading } = useUser();
  const token = session?.access_token;
  const [state, setState] = useState<{ userId: string; items: BookingConnectionStatus[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BookingProvider | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [managed, setManaged] = useState<BookingProvider | null>(null);
  const requestId = useRef(0);
  const windowRef = useRef<Window | null>(null);

  const refresh = useCallback(async () => {
    const current = ++requestId.current;
    if (!userId) { setState(null); setError(null); return; }
    try {
      const response = await fetch("/api/scheduling/connections", {
        credentials: "include", cache: "no-store",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.connections)) throw new Error("Could not check your booking connections. Try again.");
      if (current !== requestId.current) return;
      setState({ userId, items: data.connections });
      setError(null);
    } catch {
      if (current === requestId.current) { setState(null); setError("Could not check your booking connections. Try again."); }
    }
  }, [userId, token]);

  useEffect(() => {
    void refresh();
    const onFocus = () => { if (windowRef.current?.closed) setWaiting(false); void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { ++requestId.current; window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  function connect(provider: BookingProvider, setup = false) {
    // The entire composer, including File objects, remains mounted in this window.
    const popup = window.open(setup ? "/scheduling/google" : `/scheduling/connect?provider=${provider}`, "_blank", "popup,width=600,height=760");
    if (!popup) {
      setError("Your browser blocked the connection window. Allow popups for CreatorNet, then try again. Your draft is still here.");
      return;
    }
    windowRef.current = popup;
    setWaiting(true);
    setError(null);
  }

  async function disconnect(provider: BookingProvider) {
    setBusy(provider);
    setError(null);
    try {
      const response = await fetch("/api/scheduling/connections", {
        method: "DELETE", credentials: "include",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ provider }),
      });
      if (!response.ok) throw new Error("Could not disconnect. Please try again.");
      await refresh();
    } catch { setError("Could not finish disconnecting. Please try again."); }
    finally { setBusy(null); }
  }

  const items = state?.userId === userId ? state.items : null;
  const hasConnection = items?.some(item => item.status === "connected") === true;
  const title = hasConnection && purpose ? "Choose your booking event" : purpose === "session" ? "Connect your booking provider for this 1-on-1 session"
    : purpose === "sales-call" ? "Connect your booking provider for sales calls" : "Booking provider connections";
  return <section aria-label="Booking provider connections" className="space-y-3 rounded-xl border border-white/15 bg-white/5 p-4 text-white">
    <h2 className="text-sm font-semibold">{title}</h2>
    {purpose && !hasConnection && <p className="text-sm text-white/70">Connect once to confirm bookings automatically. Your draft stays here while you authorize your account.</p>}
    {error && <p role="alert" className="text-sm text-red-300">{error} <button type="button" onClick={() => void refresh()} className="underline">Check again</button></p>}
    {!loading && !userId ? <p className="text-sm"><a href="/auth" target="_blank" rel="noopener noreferrer" className="underline">Sign in to CreatorNet</a> to manage your booking connections, then return here.</p>
      : !items && !error && <p role="status">Checking connections…</p>}
    {waiting && <p role="status" className="text-sm">Finish connecting in the other window, then return here. <button type="button" className="underline" onClick={() => { setWaiting(false); void refresh(); }}>I’m back</button></p>}
    {items?.map(item => {
      const name = BOOKING_PROVIDER_NAMES[item.provider];
      const connected = item.status === "connected";
      const reconnect = item.status === "reconnect_required";
      const setup = item.provider === "google" && item.status === "pending";
      return <div key={item.provider} className="space-y-2 rounded-lg border border-white/10 p-3">
        <p className="font-medium">{name} {connected ? "connected" : setup ? "needs booking settings" : reconnect ? "needs reconnection" : item.status === "disconnecting" ? "disconnecting" : "not connected"}</p>
        {connected && item.accountName && <p className="text-sm text-white/70">{item.accountName}</p>}
        {!item.available && <p className="text-sm text-white/70">{name} connection setup is not available yet.</p>}
        {item.available && !connected && !setup && item.status !== "disconnecting" && <button type="button" className="rounded-lg bg-white px-3 py-2 text-sm text-black" onClick={() => connect(item.provider)}>{reconnect ? "Reconnect" : "Connect"} {name}</button>}
        {item.available && setup && <button type="button" className="rounded-lg bg-white px-3 py-2 text-sm text-black" onClick={() => connect("google", true)}>Set up Google Calendar</button>}
        {item.status !== "disconnected" && <button type="button" className="text-sm underline" onClick={() => setManaged(managed === item.provider ? null : item.provider)}>Manage {name}</button>}
        {(managed === item.provider || item.status === "disconnecting") && <div className="flex flex-wrap gap-3 text-sm">
          {item.provider === "google" && (connected || setup) && <button type="button" className="underline" onClick={() => connect("google", true)}>Edit calendars and booking hours</button>}
          {item.available && <button type="button" className="underline" onClick={() => connect(item.provider)}>Reconnect {name}</button>}
          <button type="button" className="underline" disabled={busy === item.provider} onClick={() => void disconnect(item.provider)}>{busy === item.provider ? "Disconnecting…" : `Disconnect ${name}`}</button>
        </div>}
        {connected && item.available && onSelect && <label className="block text-sm">{purpose === "session" ? "Session" : "Sales call"} event
          <select className="mt-1 block w-full rounded border border-white/20 bg-black p-2" value={item.eventTypes.some(event => event.bookingUrl === value) ? value : ""} onChange={event => onSelect(event.target.value)}>
            <option value="">Choose an event</option>
            {item.eventTypes.map(event => <option key={event.id} value={event.bookingUrl}>{event.title}</option>)}
          </select>
          {!item.eventTypes.length && <span>{item.provider === "google" ? "Set up your calendar and booking hours, then check again." : `Create an event in ${name}, then check again.`}</span>}
        </label>}
      </div>;
    })}
  </section>;
}
