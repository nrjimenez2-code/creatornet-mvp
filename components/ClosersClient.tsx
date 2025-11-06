// components/ClosersClient.tsx
"use client";

import { useMemo, useState } from "react";
import { createClientComponentClient } from "@supabase/auth-helpers-nextjs";

export type CloserRow = {
  id: string;
  name: string;
  booking_url: string;
  weight: number;
  active: boolean;
};

type Props = {
  userId: string | null;
  initialRows: CloserRow[];
};

export default function ClosersClient({ userId, initialRows }: Props) {
  const supabase = createClientComponentClient();
  const [rows, setRows] = useState<CloserRow[]>(initialRows);

  // form state
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [weight, setWeight] = useState<number>(1);
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);

  // simple URL validation: allow https://… OR relative /api/book?…
  const urlLooksValid = useMemo(() => {
    const u = url.trim();
    return /^https?:\/\//i.test(u) || u.startsWith("/api/book");
  }, [url]);

  async function handleAdd() {
    if (!userId) {
      alert("You must be signed in.");
      return;
    }
    if (!urlLooksValid) {
      alert("Enter a https:// link or an /api/book?... link");
      return;
    }

    const clean: Omit<CloserRow, "id"> & { creator_id: string } = {
      creator_id: userId,
      name: name.trim() || "Closer",
      booking_url: url.trim(),
      weight: Number.isFinite(weight) ? Number(weight) : 1,
      active: !!active,
    };

    setSaving(true);
    const { data, error } = await supabase
      .from("closers")
      .insert(clean)
      .select("id,name,booking_url,weight,active")
      .single();

    setSaving(false);

    if (error) {
      console.error("[closers] insert error:", error);
      alert(error.message || "Failed to add closer");
      return;
    }

    const added: CloserRow = {
      id: String(data!.id),
      name: (data!.name ?? "").toString(),
      booking_url: (data!.booking_url ?? "").toString(),
      weight: Number(data!.weight ?? 1),
      active: !!data!.active,
    };

    setRows((prev) =>
      [...prev, added].sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0))
    );

    // reset form
    setName("");
    setUrl("");
    setWeight(1);
    setActive(true);
  }

  return (
    <div className="space-y-6">
      {/* Add form */}
      <section className="rounded-lg border border-gray-200 p-4">
        <h2 className="font-medium mb-3">Add booking destination</h2>

        <div className="flex flex-wrap items-center gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g., Closer A)"
            className="w-[260px] rounded-md border px-3 py-2"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://cal.com/your-slot or /api/book?creator_id=..."
            className="flex-1 min-w-[320px] rounded-md border px-3 py-2"
          />
          <input
            type="number"
            value={weight}
            onChange={(e) => setWeight(parseInt(e.target.value || "1", 10))}
            className="w-[80px] rounded-md border px-3 py-2"
            aria-label="Weight"
          />
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            Active
          </label>

          <button
            onClick={handleAdd}
            disabled={saving || !userId}
            className="rounded-md bg-black px-4 py-2 text-white disabled:opacity-60"
          >
            {saving ? "Saving…" : "Add closer"}
          </button>
        </div>

        {!urlLooksValid && url.trim().length > 0 && (
          <p className="mt-2 text-sm text-red-600">
            Enter a <code>https://</code> link or a relative <code>/api/book</code> link.
          </p>
        )}
      </section>

      {/* Table */}
      <section className="rounded-lg border border-gray-200">
        <div className="border-b px-4 py-3 font-medium">Your booking targets</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Booking URL</th>
                <th className="px-4 py-2">Weight</th>
                <th className="px-4 py-2">Active</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-4 text-gray-500" colSpan={4}>
                    No closers yet. Add your first booking link above.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="px-4 py-2">{r.name}</td>
                    <td className="px-4 py-2">
                      <a
                        href={r.booking_url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        {r.booking_url}
                      </a>
                    </td>
                    <td className="px-4 py-2">{r.weight}</td>
                    <td className="px-4 py-2">{r.active ? "Yes" : "No"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
