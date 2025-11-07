"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createBrowserClient } from "@/lib/supabaseBrowser";
import Link from "next/link";

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

export default function ClosersManagerPage() {
  const supabase = useMemo(() => createBrowserClient(), []);
  const [creatorId, setCreatorId] = useState<string | null>(null);

  // list state
  const [targets, setTargets] = useState<Target[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingRow, setSavingRow] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ url: string; target_id: string } | null>(null);

  // add form
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newWeight, setNewWeight] = useState<number>(1);
  const [newActive, setNewActive] = useState(true);

  // get current user → creator id (profiles.id == auth.uid)
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      const uid = data.user?.id || null;
      setCreatorId(uid);
    })();
  }, [supabase]);

  const loadTargets = useCallback(async () => {
    if (!creatorId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("booking_targets")
      .select("id, creator_id, name, booking_url, weight, active, uses_count, last_used_at")
      .eq("creator_id", creatorId)
      .order("name", { ascending: true });
    if (!error && data) setTargets(data as Target[]);
    setLoading(false);
  }, [supabase, creatorId]);

  useEffect(() => {
    if (creatorId) loadTargets();
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

  const addTarget = async () => {
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
  };

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
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-bold mb-2">Booking Targets (Round-Robin)</h1>
      <p className="text-sm text-gray-600 mb-6">
        Add one or more booking URLs for your sales team. We’ll automatically rotate them using{" "}
        <code>next_booking_target()</code>. Counters are stored per target and update each time your
        CTA hits <code>/api/book</code>.
      </p>

      {/* Add form */}
      <div className="rounded-xl border p-4 mb-6 space-y-3">
        <h2 className="font-semibold">Add booking destination</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name (e.g., Closer A)"
            className="w-full rounded-lg border px-3 py-2"
          />
          <input
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="https://cal.com/your-slot or any book URL"
            className="w-full rounded-lg border px-3 py-2"
          />
        </div>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={0}
            value={newWeight}
            onChange={(e) => setNewWeight(parseInt(e.target.value || "0", 10))}
            className="w-24 rounded-lg border px-3 py-2"
          />
          <label className="text-sm text-gray-700">Weight</label>

          <label className="ml-4 inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={newActive}
              onChange={(e) => setNewActive(e.target.checked)}
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
          <div className="text-sm">
            Next pick →{" "}
            <a className="underline" href={testResult.url} target="_blank" rel="noreferrer">
              {testResult.url}
            </a>{" "}
            <span className="text-gray-500">(target_id: {testResult.target_id})</span>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
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
                <td className="px-3 py-4 text-gray-500" colSpan={7}>
                  Loading…
                </td>
              </tr>
            ) : targets.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-gray-500" colSpan={7}>
                  No booking targets yet.
                </td>
              </tr>
            ) : (
              targets.map((t) => <Row key={t.id} t={t} onSave={saveRow} onDelete={removeRow} saving={savingRow === t.id} />)
            )}
          </tbody>
        </table>
      </div>

      {/* How to use */}
      <div className="text-xs text-gray-600 mt-6">
        <p className="mb-2 font-medium">Use this CTA URL in your posts/buttons:</p>
        <code className="block break-all rounded-lg bg-gray-100 px-3 py-2">
          {creatorId
            ? `/api/book?creator_id=${creatorId}&post_id=<optional_post_id>`
            : `/api/book?creator_id=<your_id>&post_id=<optional_post_id>`}
        </code>
        <p className="mt-2">
          If a post has its own <code>booking_url</code>, the API will prefer that override.
        </p>
      </div>
    </div>
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
        {t.last_used_at ? new Date(t.last_used_at).toLocaleString() : <span className="text-gray-400">—</span>}
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
