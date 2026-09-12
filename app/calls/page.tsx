"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

type Call = { id: string; title: string; status: string; access_granted: boolean };
export default function CallsPage() {
  const [items, setItems] = useState<Call[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [run, setRun] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/calls?offset=" + offset, { credentials: "include", signal: controller.signal });
        const data = await res.json();
        if (!res.ok) throw Error(data.error || "Your calls could not be loaded.");
        if (!controller.signal.aborted) { setItems(data.items); setHasMore(data.hasMore === true); }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Your calls could not be loaded.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [offset, run]);
  return <main className="mx-auto max-w-3xl p-6">
    <Link href="/library" className="text-sm underline">Back to Library</Link>
    <h1 className="mb-3 mt-6 text-2xl font-semibold">Your paid calls</h1>
    <p className="mb-6 text-sm opacity-70">Choose a time after payment is confirmed. For rescheduling or help, contact your creator or support@creatornet.net.</p>
    {loading ? <p role="status">Loading your calls...</p> : error ? <div role="alert"><p>{error}</p><button className="mt-3 underline" onClick={() => { setLoading(true); setError(""); setRun(n => n + 1); }}>Try again</button></div> : <>
      {items.length === 0 && <p>No paid calls on this page.</p>}
      <div className="space-y-4">{items.map(call => <article key={call.id} className="rounded-xl border border-gray-600 p-4">
        <h2 className="font-semibold">{call.title}</h2>
        {call.access_granted ? <a className="mt-3 inline-block rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black" href={"/api/calls/" + call.id + "/schedule"}>Schedule call</a> : <p className="mt-2 text-sm">{["pending", "processing"].includes(call.status) ? "Awaiting payment confirmation. Please do not pay again." : "Scheduling access is unavailable. Contact support about this purchase."}</p>}
      </article>)}</div>
      <div className="mt-6 flex gap-4"><button disabled={offset === 0} onClick={() => { setLoading(true); setError(""); setOffset(n => Math.max(0, n - 20)); }} className="underline disabled:opacity-40">Previous</button><button disabled={!hasMore} onClick={() => { setLoading(true); setError(""); setOffset(n => n + 20); }} className="underline disabled:opacity-40">Next</button></div>
    </>}
  </main>;
}
