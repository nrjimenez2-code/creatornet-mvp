"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabaseBrowser";

type CloserRow = {
  creator_id: string;
  name: string | null;
  booking_url: string | null;
  weight: number | null;
  active: boolean | null;
};

export default function ClosersPage() {
  const supabase = supabaseBrowser();

  const [loading, setLoading] = useState(true);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [rows, setRows] = useState<CloserRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 1) Get session safely (don’t throw if still restoring)
      const { data: s } = await supabase.auth.getSession();
      const uid = s?.session?.user?.id ?? null;
      if (cancelled) return;

      setSessionUserId(uid);

      if (!uid) {
        setLoading(false);
        return; // not signed in — render CTA below
      }

      // 2) Load closers for this creator/user
      const { data, error } = await supabase
        .from("closers")
        .select("creator_id,name,booking_url,weight,active")
        .eq("creator_id", uid);

      if (cancelled) return;

      if (error) setErr(error.message);
      else setRows(data ?? []);

      setLoading(false);
    })();

    // keep session in sync if they sign in/out
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, sess) => {
      setSessionUserId(sess?.user?.id ?? null);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-4">Closers</h1>

      {/* Not signed in */}
      {!sessionUserId && !loading && (
        <div className="rounded-lg border bg-white p-4">
          <p className="text-red-600 font-medium mb-2">You must be signed in.</p>
          <Link
            href="/auth"
            className="inline-flex items-center rounded-md bg-black px-3 py-1.5 text-white"
          >
            Go to sign in
          </Link>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="rounded-lg border bg-white p-4 text-gray-600">
          Loading…
        </div>
      )}

      {/* Error */}
      {err && (
        <div className="rounded-lg border bg-white p-4 text-red-600">
          {err}
        </div>
      )}

      {/* Table */}
      {!loading && sessionUserId && !err && (
        <div className="rounded-lg border bg-white">
          <div className="px-4 py-3 border-b font-medium">Your booking targets</div>
          {rows.length === 0 ? (
            <div className="p-4 text-gray-600">
              No closers yet. Add a row in <code>public.closers</code> for your
              <code>creator_id</code> with a valid <code>booking_url</code>, or we’ll
              add an editor UI here later.
            </div>
          ) : (
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  <th className="px-4 py-2 text-left">Name</th>
                  <th className="px-4 py-2 text-left">Booking URL</th>
                  <th className="px-4 py-2 text-left">Weight</th>
                  <th className="px-4 py-2 text-left">Active</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-4 py-2">{r.name ?? "—"}</td>
                    <td className="px-4 py-2">
                      {r.booking_url ? (
                        <a
                          href={r.booking_url}
                          target="_blank"
                          className="text-indigo-600 underline"
                          rel="noreferrer"
                        >
                          {r.booking_url}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2">{r.weight ?? 0}</td>
                    <td className="px-4 py-2">{r.active ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
