// app/access/[purchaseId]/page.tsx
import { createServerClient } from "@/lib/supabaseServer";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AccessPage({
  params,
}: {
  params: { purchaseId: string };
}) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main className="p-8">
        <h1 className="text-2xl font-semibold mb-2">Sign in required</h1>
        <p className="text-gray-600">
          Please sign in to view your purchase access.
        </p>
        <Link href="/auth" className="underline mt-4 inline-block">
          Go to sign in
        </Link>
      </main>
    );
  }

  // Fetch purchase and gate to the buyer
  const { data: p, error } = await supabase
    .from("purchases")
    .select(
      "id,buyer_id,creator_id,product_id,post_id,status,fulfillment,fulfillment_url,fulfillment_payload,paid_count,target_months"
    )
    .eq("id", params.purchaseId)
    .single();

  if (error || !p) {
    return (
      <main className="p-8">
        <h1 className="text-2xl font-semibold mb-2">Not found</h1>
        <p className="text-gray-600">We couldn’t find that purchase.</p>
        <Link href="/dashboard" className="underline mt-4 inline-block">
          Back to dashboard
        </Link>
      </main>
    );
  }

  if (p.buyer_id !== user.id) {
    return (
      <main className="p-8">
        <h1 className="text-2xl font-semibold mb-2">Access denied</h1>
        <p className="text-gray-600">This purchase doesn’t belong to you.</p>
        <Link href="/dashboard" className="underline mt-4 inline-block">
          Back to dashboard
        </Link>
      </main>
    );
  }

  const label =
    p.fulfillment === "discord"
      ? "Open Discord"
      : p.fulfillment === "whop"
      ? "Open Whop"
      : "Open Link";

  return (
    <main className="p-6">
      <div className="max-w-xl mx-auto">
        <h1 className="text-2xl font-semibold mb-4">Your Access</h1>

        <div className="rounded-2xl border p-5 space-y-4">
          <div className="text-sm text-gray-500">
            Status:{" "}
            <span className="font-medium text-gray-800">
              {p.status ?? "paid"}
            </span>
            {typeof p.paid_count === "number" && p.target_months ? (
              <span className="ml-2 text-gray-500">
                • {p.paid_count}/{p.target_months} months
              </span>
            ) : null}
          </div>

          {p.fulfillment_url ? (
            <>
              <div className="text-sm text-gray-500">Fulfillment</div>
              <div className="font-medium mb-2">
                {p.fulfillment ?? "link"}
              </div>

              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={p.fulfillment_url}
                  className="flex-1 rounded-md border px-3 py-2 text-sm"
                />
                <form
                  action={async () => {
                    "use server";
                  }}
                >
                  {/* client-only clipboard handled via button below */}
                </form>
              </div>

              <div className="mt-3 flex gap-3">
                <button
                  className="rounded-xl border px-4 py-2 text-sm"
                  onClick={async () => {
                    await navigator.clipboard.writeText(p.fulfillment_url!);
                    alert("Link copied");
                  }}
                >
                  Copy link
                </button>

                <a
                  href={p.fulfillment_url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-xl border px-4 py-2 text-sm"
                >
                  {label}
                </a>
              </div>
            </>
          ) : (
            <>
              <div className="text-sm text-gray-500">Access pending</div>
              <p className="text-gray-700">
                We’re finalizing your access. This usually appears right after
                the first successful payment.
              </p>
            </>
          )}
        </div>

        <div className="mt-6">
          <Link href="/dashboard" className="underline">
            Back to dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
