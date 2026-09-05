"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserClient } from "@/lib/supabaseBrowser";
import { useUser } from "@/lib/useUser";
import Link from "next/link";
import BackButton from "@/components/BackButton";
import InstallmentLinkForm from "@/components/InstallmentLinkForm";
import { platformFeeCents as legacyPlatformFeeCents } from "@/lib/money";

type Target = {
  id: string;
  creator_id: string;
  name: string | null;
  booking_url: string;
  weight: number | null;
  active: boolean | null;
  uses_count: number | null;
  last_used_at: string | null;
};

type BookingPayment = {
  id: string;
  booking_id: string;
  plan_type: "full" | "installment";
  installment_months: number | null;
  status: string;
  link_url: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_subscription_id: string | null;
  amount_total_cents: number | null;
  installment_amount_cents: number | null;
  platform_fee_cents: number | null;
  processing_fee_cents: number | null;
  total_creator_deduction_cents: number | null;
  creator_net_cents: number | null;
  fee_schedule_version: string | null;
  currency: string | null;
  created_at: string;
  completed_at: string | null;
  link_sent_at: string | null;
  closer_user_id: string | null;
  closer_profile?: {
    id: string;
    username: string | null;
    full_name: string | null;
    avatar_url: string | null;
  } | null;
};

type BookingBundle = {
  booking: {
    id: string;
    post_id: string;
    buyer_id: string;
    creator_id: string;
    status: string;
    linked_order_id?: string | null;
    created_at: string;
  };
  post: {
    id: string;
    title: string | null;
    product_id: string | null;
    product_type?: string | null;
    amount_cents?: number | null;
    price_cents?: number | null;
  } | null;
  product: {
    id: string;
    title: string | null;
    amount_cents: number | null;
    currency: string | null;
    stripe_price_id?: string | null;
  } | null;
  buyer: {
    id: string;
    username: string | null;
    full_name: string | null;
    avatar_url: string | null;
  } | null;
  payments: BookingPayment[];
};

export default function ClosersManagerPage() {
  const supabase = useMemo(() => createBrowserClient(), []);
  // creator id (profiles.id == auth.uid) and access token come from the shared auth context
  const { userId: creatorId, session } = useUser();
  const accessToken = session?.access_token ?? null;

  // list state
  const [targets, setTargets] = useState<Target[]>([]);
  const [loading, setLoading] = useState(true);
  const [targetsError, setTargetsError] = useState(false);
  const [savingRow, setSavingRow] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ url: string; target_id: string } | null>(null);
  const [bookings, setBookings] = useState<BookingBundle[]>([]);
  const [bookingsLoading, setBookingsLoading] = useState(false);
  const [bookingsError, setBookingsError] = useState<string | null>(null);
  const [generatingLinkKey, setGeneratingLinkKey] = useState<string | null>(null);
  const generatingLinkRef = useRef(false);
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  const [latestLink, setLatestLink] = useState<{ bookingId: string; url: string } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // add form
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newWeight, setNewWeight] = useState<number>(1);
  const [newActive, setNewActive] = useState(true);

  const loadTargets = useCallback(async () => {
    if (!creatorId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("booking_targets")
      .select("id, creator_id, name, booking_url, weight, active, uses_count, last_used_at")
      .eq("creator_id", creatorId)
      .order("name", { ascending: true });
    if (!error && data) {
      setTargets(data as Target[]);
      setTargetsError(false);
    } else {
      // A swallowed load error looked like an empty list, inviting duplicate re-adds.
      console.error("Booking targets load failed:", error);
      setTargetsError(true);
    }
    setLoading(false);
  }, [supabase, creatorId]);

  useEffect(() => {
    if (!creatorId) return;
    const timeoutId = window.setTimeout(() => void loadTargets(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [creatorId, loadTargets]);

  // helpers
  const isHttp = (s: string) => {
    try {
      const u = new URL(s);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  };

  const formatMoney = (
    cents: number | null | undefined,
    currency: string | null | undefined = "usd"
  ) => {
    if (!Number.isFinite(cents)) return "—";
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: (currency || "usd").toUpperCase(),
        minimumFractionDigits: 2,
      }).format((cents ?? 0) / 100);
    } catch {
      return `$${((cents ?? 0) / 100).toFixed(2)}`;
    }
  };

  const copyToClipboard = async (value: string | null | undefined) => {
    if (!value) {
      setLinkMessage("Nothing to copy.");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setLinkMessage("Link copied to clipboard.");
    } catch {
      setLinkMessage("Unable to copy automatically. Please copy the link manually.");
    }
  };

  const addTarget = useCallback(async () => {
    if (!creatorId) return;
    if (!newUrl || !isHttp(newUrl)) {
      alert("Enter a valid http(s) booking URL.");
      return;
    }
    const row = {
      creator_id: creatorId,
      name: newName || null,
      booking_url: newUrl.trim(),
      weight: Number.isFinite(newWeight) ? Math.max(0, Math.floor(newWeight)) : 1,
      active: !!newActive,
    };
    const { error } = await supabase
      .from("booking_targets")
      .upsert(row, { onConflict: "creator_id,booking_url" }); // idempotent add/update by URL
    if (error) {
      alert(error.message);
      return;
    }
    setNewName("");
    setNewUrl("");
    setNewWeight(1);
    setNewActive(true);
    await loadTargets();
  }, [creatorId, newUrl, newName, newWeight, newActive, supabase, loadTargets]);

  const saveRow = async (id: string, patch: Partial<Target>) => {
    setSavingRow(id);
    const { error } = await supabase.from("booking_targets").update(patch).eq("id", id);
    setSavingRow(null);
    if (error) {
      alert(error.message);
      return;
    }
    await loadTargets();
  };

  const removeRow = async (id: string) => {
    if (!confirm("Delete this booking target?")) return;
    const { error } = await supabase.from("booking_targets").delete().eq("id", id);
    if (error) {
      alert(error.message);
      return;
    }
    await loadTargets();
  };

  const fetchBookings = useCallback(async () => {
    setBookingsLoading(true);
    setBookingsError(null);
    try {
      const token = accessToken;
      if (!token) {
        throw new Error("Missing auth session. Please sign in again.");
      }
      const res = await fetch("/api/bookings/list", {
        credentials: "include",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Failed to load bookings (${res.status})`);
      }
      setBookings(data.bookings ?? []);
    } catch (err: any) {
      console.error("[bookings] load error:", err?.message || err);
      setBookingsError(err?.message || "Unable to load bookings.");
    } finally {
      setBookingsLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    if (!creatorId || !accessToken) return;
    const timeoutId = window.setTimeout(() => void fetchBookings(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [creatorId, accessToken, fetchBookings]);

  const handleGenerateLink = async (
    bookingId: string,
    plan: "full" | "installment",
    months?: number,
  ): Promise<boolean> => {
    if (generatingLinkRef.current) return false;
    if (plan === "installment") {
      if (months === undefined || !Number.isInteger(months) || months < 2 || months > 24) {
        setLinkMessage("Installment months must be an integer between 2 and 24.");
        return false;
      }
    }

    const key = `${bookingId}:${plan}`;
    generatingLinkRef.current = true;
    setGeneratingLinkKey(key);
    setLinkMessage(null);
    setLatestLink(null);

    try {
      const res = await fetch(`/api/bookings/${bookingId}/payment-link`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          plan_type: plan,
          installment_months: months,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const message = data?.error || `Failed to generate payment link (${res.status})`;
        const info = {
          details: data?.details ?? data?.supabase?.details ?? null,
          hint: data?.supabase?.hint ?? null,
          status: res.status,
        };
        console.error("[payment-link] response error:", { message, ...info });
        throw new Error(message);
      }

      const payment: BookingPayment | undefined = data?.payment;
      if (!payment) {
        throw new Error("Payment record missing from response");
      }

      setBookings((prev) =>
          prev.map((bundle) =>
          bundle.booking.id === bookingId
            ? {
                ...bundle,
                payments: [
                  payment,
                  ...(bundle.payments ?? []).filter((row) => row.id !== payment.id),
                ],
              }
            : bundle
        )
      );

      if (data?.url) {
        setLatestLink({ bookingId, url: data.url });
        // Clipboard permission may remain pending after the API succeeds.
        // Finish creation now; copying is a separate, explicit user action.
        setLinkMessage("Link generated. Use Copy latest link or Open below.");
      } else {
        setLinkMessage("Link generated. Copy it from the list below.");
      }
      return true;
    } catch (err: any) {
      console.error("[payment-link] error:", err?.message || err);
      setLinkMessage(err?.message || "Failed to generate payment link.");
      return false;
    } finally {
      generatingLinkRef.current = false;
      setGeneratingLinkKey(null);
    }
  };

  const handleDeleteBooking = useCallback(
    async (bookingId: string) => {
      if (!bookingId) return;
      if (!window.confirm("Remove this booking and any generated links?")) return;
      setDeletingId(bookingId);
      try {
        const currentToken = accessToken;
        if (!currentToken) {
          throw new Error("Missing auth session. Please sign in again.");
        }
        const res = await fetch(`/api/bookings/${bookingId}`, {
          method: "DELETE",
          credentials: "include",
          headers: {
            ...(currentToken ? { Authorization: `Bearer ${currentToken}` } : {}),
          },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.error || `Failed to remove booking (${res.status})`);
        }

        setBookings((prev) => prev.filter((bundle) => bundle.booking.id !== bookingId));
        if (latestLink?.bookingId === bookingId) {
          setLatestLink(null);
        }
        setLinkMessage("Booking removed.");
      } catch (err: any) {
        console.error("[booking-delete] error:", err?.message || err);
        alert(err?.message || "Failed to remove booking.");
      } finally {
        setDeletingId(null);
      }
    },
    [accessToken, latestLink]
  );

  const testRoundRobin = async () => {
    if (!creatorId) return;
    setTesting(true);
    setTestResult(null);
    const { data, error } = await supabase.rpc("next_booking_target", { p_creator_id: creatorId });
    setTesting(false);
    if (error) {
      alert(error.message);
      return;
    }
    // function returns one row with { target_id, booking_url }
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.booking_url) {
      setTestResult({ url: row.booking_url, target_id: row.target_id });
      // reload to reflect uses_count/last_used_at bump
      await loadTargets();
    } else {
      alert("No active booking targets found for this creator.");
    }
  };

  return (
    <main className="max-w-5xl mx-auto p-6 space-y-8 text-white">
      {/* Mobile: Back button on top, heading below and left-aligned */}
      <div className="block md:hidden mb-6">
        <div className="mb-3">
          <BackButton />
        </div>
        <h1 className="text-lg font-bold text-left">Booking Targets (Round-Robin)</h1>
      </div>

      {/* Desktop: Absolute positioned back button + heading below (original) */}
      <div className="hidden md:block absolute top-4 left-4 z-10">
        <BackButton />
      </div>
      <h1 className="hidden md:block text-xl font-bold mb-2">Booking Targets (Round-Robin)</h1>
      <p className="text-sm text-white/80 mb-6">
        Add one or more booking URLs for your sales team. We’ll automatically rotate them using{" "}
        <code>next_booking_target()</code>. Counters are stored per target and update each time your
        CTA hits <code>/api/book</code>.
      </p>

      {/* Add form */}
      <div className="rounded-xl border p-4 mb-6 space-y-3">
        <h2 className="font-semibold text-white">Add booking destination</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name (e.g., Closer A)"
            className="w-full rounded-lg border px-3 py-2"
            suppressHydrationWarning
          />
          <input
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="https://cal.com/your-slot or any book URL"
            className="w-full rounded-lg border px-3 py-2"
            suppressHydrationWarning
          />
        </div>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={0}
            value={newWeight}
            onChange={(e) => setNewWeight(parseInt(e.target.value || "0", 10))}
            className="w-24 rounded-lg border px-3 py-2"
            suppressHydrationWarning
          />
          <label className="text-sm text-white/90">Weight</label>

          <label className="ml-4 inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={newActive}
              onChange={(e) => setNewActive(e.target.checked)}
              suppressHydrationWarning
            />
            Active
          </label>

          <button
            onClick={addTarget}
            className="ml-auto rounded-full bg-black text-white px-4 py-2"
          >
            Add
          </button>
        </div>
      </div>

      {/* Test round robin */}
      <div className="rounded-xl border p-4 mb-6 flex items-center gap-3">
        <button
          onClick={testRoundRobin}
          disabled={testing || !creatorId}
          className="rounded-full border px-4 py-2 disabled:opacity-50"
        >
          {testing ? "Testing…" : "Test round-robin"}
        </button>
        {testResult && (
          <div className="text-sm text-white">
            Next pick →{" "}
            <a className="underline" href={testResult.url} target="_blank" rel="noreferrer">
              {testResult.url}
            </a>{" "}
            <span className="text-white/70">(target_id: {testResult.target_id})</span>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[#181818] text-white">
            <tr className="text-left">
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Booking URL</th>
              <th className="px-3 py-2 w-24">Weight</th>
              <th className="px-3 py-2 w-28">Active</th>
              <th className="px-3 py-2 w-24">Used</th>
              <th className="px-3 py-2 w-48">Last used</th>
              <th className="px-3 py-2 w-40"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-3 py-4 text-white/70" colSpan={7}>
                  Loading…
                </td>
              </tr>
            ) : targetsError ? (
              <tr>
                <td className="px-3 py-4 text-red-300" colSpan={7}>
                  Couldn&apos;t load your booking targets.{" "}
                  <button type="button" onClick={() => loadTargets()} className="underline">
                    Try again
                  </button>
                </td>
              </tr>
            ) : targets.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-white/70" colSpan={7}>
                  No booking targets yet.
                </td>
              </tr>
            ) : (
              targets.map((t) => <Row key={t.id} t={t} onSave={saveRow} onDelete={removeRow} saving={savingRow === t.id} />)
            )}
          </tbody>
        </table>
      </div>

      {/* Bookings & payments */}
      <section className="rounded-xl border p-4 space-y-4 bg-white/5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-lg">Bookings & payments</h2>
            <p className="text-sm text-white/80">
              Generate Stripe checkout links to send after your calls.
            </p>
            <p className="mt-1 text-xs text-white/60">
              CreatorNet charges a 12% platform fee. Standard payment-processing fees are
              deducted separately.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchBookings}
              className="rounded-full border px-4 py-2 text-sm"
              disabled={bookingsLoading || generatingLinkKey !== null}
            >
              {bookingsLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {linkMessage ? (
          <div role="status" className="rounded-lg bg-black/80 px-3 py-2 text-sm text-white/90">{linkMessage}</div>
        ) : null}

        {bookingsError ? (
          <div className="rounded-lg bg-red-900/40 px-3 py-2 text-sm text-red-200">{bookingsError}</div>
        ) : bookingsLoading ? (
          <div className="text-sm text-white/70">Loading bookings…</div>
        ) : bookings.length === 0 ? (
          <div className="text-sm text-white/70">No bookings yet. Calls will show up here once they are scheduled.</div>
        ) : (
          <div className="space-y-4">
            {bookings.map((bundle) => {
              const buyerName =
                bundle.buyer?.full_name ||
                bundle.buyer?.username ||
                "Unknown buyer";
              const productTitle =
                bundle.product?.title || bundle.post?.title || "Untitled product";
              const totalAmount =
                bundle.product?.amount_cents ??
                bundle.post?.amount_cents ??
                bundle.post?.price_cents ??
                null;
              const currency = bundle.product?.currency || "usd";
              const createdAt = new Date(bundle.booking.created_at).toLocaleString();

              return (
                <div
                  key={bundle.booking.id}
                  className="rounded-xl border border-gray-500/40 bg-black/60 px-4 py-4 text-white"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase text-white/60">Buyer</div>
                      <div className="font-medium text-sm">{buyerName}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase text-white/60">Created</div>
                      <div className="text-sm text-white/80">{createdAt}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div>
                        <div className="text-xs uppercase text-white/60">Status</div>
                        <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs font-medium capitalize text-white">
                          {bundle.booking.status.replace(/_/g, " ")}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteBooking(bundle.booking.id)}
                        disabled={deletingId === bundle.booking.id || generatingLinkKey !== null}
                        aria-label="Delete booking"
                        className="rounded-full border border-[#4A35C7] bg-white/10 h-6 w-6 text-[#7A6BC4] transition hover:bg-[#4A35C7] hover:text-white disabled:opacity-50 flex items-center justify-center"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">Product:</span>
                    <span>{productTitle}</span>
                    {totalAmount ? (
                      <span className="text-white/70">
                        {formatMoney(totalAmount, currency)}
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <button
                      className="rounded-full bg-[#4A35C7] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                      disabled={generatingLinkKey !== null || deletingId !== null}
                      onClick={() => handleGenerateLink(bundle.booking.id, "full")}
                    >
                      {generatingLinkKey === `${bundle.booking.id}:full`
                        ? "Creating…"
                        : "Generate full payment link"}
                    </button>
                    <InstallmentLinkForm
                      disabled={generatingLinkKey !== null || deletingId !== null}
                      onGenerate={(months) => handleGenerateLink(bundle.booking.id, "installment", months)}
                    />
                    {latestLink?.bookingId === bundle.booking.id ? (
                      <button
                        className="rounded-full border border-blue-400 px-4 py-2 text-sm text-blue-200"
                        onClick={() => copyToClipboard(latestLink.url)}
                      >
                        Copy latest link
                      </button>
                    ) : null}
                  </div>

                  {bundle.payments.length > 0 && (
                    <div className="mt-4 space-y-2">
                      <div className="text-xs uppercase text-white/60">
                        Payment links
                      </div>
                      {bundle.payments.map((payment) => {
                        const paidLabel = payment.status.replace(/_/g, " ");
                        const paymentCreated = new Date(payment.created_at).toLocaleString();
                        const grossPerPayment =
                          payment.plan_type === "installment"
                            ? payment.installment_amount_cents
                            : payment.amount_total_cents;
                        const historicalWithoutBreakdown =
                          payment.creator_net_cents === null;
                        const platformFeeCents =
                          historicalWithoutBreakdown && grossPerPayment !== null
                            ? legacyPlatformFeeCents(grossPerPayment)
                            : payment.platform_fee_cents;
                        const processingFeeCents = payment.processing_fee_cents ?? 0;
                        const creatorNetCents =
                          payment.creator_net_cents ??
                          (grossPerPayment !== null && platformFeeCents !== null
                            ? Math.max(
                                0,
                                grossPerPayment -
                                  platformFeeCents -
                                  processingFeeCents,
                              )
                            : null);
                        const splitLabel =
                          payment.status === "pending" || payment.status === "link_sent"
                            ? "Expected per payment"
                            : "Recorded per payment";

                        return (
                          <div
                            key={payment.id}
                            className="rounded-lg border border-white/30 bg-white/10 px-3 py-3 text-sm text-white"
                          >
                            <div className="flex flex-wrap items-center gap-3">
                              <span className="font-semibold capitalize">{payment.plan_type}</span>
                              <span className="text-white/70 capitalize">{paidLabel}</span>
                              {payment.installment_months !== null ? (
                                <span className="text-white/70">
                                  {payment.installment_months} months
                                </span>
                              ) : null}
                              {payment.installment_amount_cents !== null ? (
                                <span className="text-white/70">
                                  {formatMoney(payment.installment_amount_cents, payment.currency)} / mo
                                </span>
                              ) : null}
                              {payment.amount_total_cents !== null ? (
                                <span className="text-white/70">
                                  {formatMoney(payment.amount_total_cents, payment.currency)} total
                                </span>
                              ) : null}
                              <span className="text-white/50">{paymentCreated}</span>
                              {payment.closer_profile?.full_name || payment.closer_profile?.username ? (
                                <span className="text-white/70">
                                  by{" "}
                                  {payment.closer_profile.full_name ||
                                    payment.closer_profile.username}
                                </span>
                              ) : null}
                              <div className="ml-auto flex items-center gap-2">
                                {payment.link_url ? (
                                  <>
                                    <button
                                      onClick={() => copyToClipboard(payment.link_url)}
                                      className="rounded-full border border-white/40 px-3 py-1 text-xs text-white"
                                    >
                                      Copy
                                    </button>
                                    <a
                                      href={payment.link_url}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-xs text-blue-200 underline"
                                    >
                                      Open
                                    </a>
                                  </>
                                ) : (
                                  <span className="text-xs text-white/50">Link unavailable</span>
                                )}
                              </div>
                            </div>

                            {grossPerPayment !== null ? (
                              <div className="mt-3 border-t border-white/15 pt-3">
                                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/50">
                                  {splitLabel}
                                </p>
                                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                                  <div>
                                    <dt className="text-[11px] text-white/50">Gross</dt>
                                    <dd className="font-medium">
                                      {formatMoney(grossPerPayment, payment.currency)}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt className="text-[11px] text-white/50">CreatorNet fee (12%)</dt>
                                    <dd className="font-medium">
                                      {formatMoney(platformFeeCents, payment.currency)}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt className="text-[11px] text-white/50">Payment processing</dt>
                                    <dd className="font-medium">
                                      {formatMoney(processingFeeCents, payment.currency)}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt className="text-[11px] text-white/50">Creator net</dt>
                                    <dd className="font-semibold text-emerald-300">
                                      {formatMoney(creatorNetCents, payment.currency)}
                                    </dd>
                                  </div>
                                </dl>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

    </main>
  );
}

function Row({
  t,
  onSave,
  onDelete,
  saving,
}: {
  t: Target;
  onSave: (id: string, patch: Partial<Target>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  saving: boolean;
}) {
  const [name, setName] = useState(t.name ?? "");
  const [url, setUrl] = useState(t.booking_url);
  const [weight, setWeight] = useState<number>(t.weight ?? 1);
  const [active, setActive] = useState<boolean>(!!t.active);

  const dirty = name !== (t.name ?? "") || url !== t.booking_url || weight !== (t.weight ?? 1) || active !== !!t.active;

  const save = async () => {
    const patch: Partial<Target> = {
      name: name || null,
      booking_url: url,
      weight: Math.max(0, Math.floor(weight || 0)),
      active,
    };
    await onSave(t.id, patch);
  };

  return (
    <tr className="border-t align-top">
      <td className="px-3 py-2">
        <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border px-2 py-1" />
      </td>
      <td className="px-3 py-2">
        <input value={url} onChange={(e) => setUrl(e.target.value)} className="w-full rounded border px-2 py-1" />
        {url ? (
          <Link href={url} target="_blank" className="text-xs text-blue-600 underline">
            open
          </Link>
        ) : null}
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          min={0}
          value={Number.isFinite(weight) ? weight : 0}
          onChange={(e) => setWeight(parseInt(e.target.value || "0", 10))}
          className="w-20 rounded border px-2 py-1"
        />
      </td>
      <td className="px-3 py-2">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>{active ? "Yes" : "No"}</span>
        </label>
      </td>
      <td className="px-3 py-2">{t.uses_count ?? 0}</td>
      <td className="px-3 py-2">
        {t.last_used_at ? new Date(t.last_used_at).toLocaleString() : <span className="text-white/60">—</span>}
      </td>
      <td className="px-3 py-2">
        <div className="flex gap-2 justify-end">
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="rounded-full border px-3 py-1 text-sm disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button onClick={() => onDelete(t.id)} className="rounded-full bg-red-600 text-white px-3 py-1 text-sm">
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

function TrashIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M9 3h6a1 1 0 0 1 .92.61L16 4h4a1 1 0 1 1 0 2h-1l-1 13a2 2 0 0 1-2 1.87H8a2 2 0 0 1-2-1.87L5 6H4a1 1 0 1 1 0-2h4l.08-.39A1 1 0 0 1 9 3Zm7 3H8l1 13h6l1-13ZM10 8a1 1 0 0 1 1 1v7a1 1 0 1 1-2 0V9a1 1 0 0 1 1-1Zm4 0a1 1 0 0 1 1 1v7a1 1 0 1 1-2 0V9a1 1 0 0 1 1-1Z" />
    </svg>
  );
}
