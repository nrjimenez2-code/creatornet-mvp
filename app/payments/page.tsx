import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { buyerRecoveryEnabled } from "@/lib/installments/buyerRecovery";
import { listBuyerPaymentPlans } from "@/lib/installments/buyerPlanList";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Your payments",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type TipHistoryRow = {
  id: string;
  creator_id: string;
  post_id: string;
  gross_amount_cents: number;
  refunded_amount_cents: number;
  currency: string;
  status: string;
  created_at: string;
};

const PAGE_SIZE = 25;

function money(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: currency.toUpperCase(),
  }).format(cents / 100);
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const user = await getAuthenticatedUser();
  if (!user) redirect("/auth?next=%2Fpayments");
  const query = await searchParams;
  const page = Number(query.page || "1");
  const validPage = Number.isSafeInteger(page) && page > 0 ? page : 1;

  let plans: Awaited<ReturnType<typeof listBuyerPaymentPlans>> | null = null;
  if (buyerRecoveryEnabled(process.env)) {
    try {
      plans = await listBuyerPaymentPlans(supabaseAdmin, user.id, validPage, process.env);
    } catch {
      // Keep the private page useful when the installment subsystem is unavailable.
    }
  }

  const tipsResult = await supabaseAdmin
    .from("tips")
    .select("id,creator_id,post_id,gross_amount_cents,refunded_amount_cents,currency,status,created_at")
    .eq("tipper_id", user.id)
    .order("created_at", { ascending: false })
    .range((validPage - 1) * PAGE_SIZE, validPage * PAGE_SIZE);
  const tipRows = (tipsResult.data ?? []) as TipHistoryRow[];
  const shownTips = tipRows.slice(0, PAGE_SIZE);
  const creatorIds = [...new Set(shownTips.map((tip) => tip.creator_id))];
  const postIds = [...new Set(shownTips.map((tip) => tip.post_id))];
  const [profilesResult, postsResult] = await Promise.all([
    creatorIds.length
      ? supabaseAdmin.from("profiles").select("id,username,full_name").in("id", creatorIds)
      : Promise.resolve({ data: [] as Array<{ id: string; username: string | null; full_name: string | null }> }),
    postIds.length
      ? supabaseAdmin.from("posts").select("id,title").in("id", postIds)
      : Promise.resolve({ data: [] as Array<{ id: string; title: string | null }> }),
  ]);
  const profiles = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile]));
  const posts = new Map((postsResult.data ?? []).map((post) => [post.id, post]));
  const tipsAvailable = !tipsResult.error;

  return (
    <main className="mx-auto max-w-3xl p-6 text-white">
      <Link href="/library" className="text-sm underline">Back to your library</Link>
      <h1 className="mt-6 text-2xl font-semibold">Your payments</h1>

      <section className="mt-8" aria-labelledby="tips-sent-heading">
        <h2 id="tips-sent-heading" className="text-xl font-semibold">Tips sent</h2>
        <p className="mt-2 text-sm text-gray-400">Your tips are private and do not unlock content.</p>
        {!tipsAvailable ? (
          <p role="alert" className="mt-4 text-sm text-red-300">Tip history is unavailable right now.</p>
        ) : shownTips.length === 0 ? (
          <p className="mt-4 text-sm text-gray-300">You have not sent any tips yet.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {shownTips.map((tip) => {
              const creator = profiles.get(tip.creator_id);
              const refunded = Number(tip.refunded_amount_cents || 0);
              const creatorName = creator?.username ? `@${creator.username}` : creator?.full_name || "Creator";
              return (
                <li key={tip.id} className="rounded-xl border border-gray-700 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <Link href={`/dashboard?postId=${encodeURIComponent(tip.post_id)}`} className="font-medium hover:underline">
                        {posts.get(tip.post_id)?.title || "Video"}
                      </Link>
                      <p className="mt-1 text-sm text-gray-400">To {creatorName} · {new Date(tip.created_at).toLocaleDateString()}</p>
                      <p className="mt-1 text-xs capitalize text-gray-500">{tip.status}{refunded > 0 ? ` · ${money(refunded, tip.currency)} refunded` : ""}</p>
                    </div>
                    <p className="font-semibold tabular-nums">{money(Number(tip.gross_amount_cents), tip.currency)}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-10 border-t border-white/10 pt-8" aria-labelledby="plans-heading">
        <h2 id="plans-heading" className="text-xl font-semibold">Payment plans</h2>
        <p className="mt-2 text-sm text-gray-400">Review installment payments. Content access and payment obligations are separate.</p>
        {plans === null ? (
          <p className="mt-4 text-sm text-gray-300">No payment plans are available for review on this page.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {plans.plans.map((plan) => (
              <li key={plan.id} className="rounded-xl border border-gray-700 p-4">
                <p className="font-medium">{plan.title}</p>
                <Link href={`/payments/recovery/${plan.id}`} className="mt-2 inline-block text-sm underline">Review payment plan</Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <nav aria-label="Payment history pages" className="mt-8 flex gap-4 text-sm">
        {validPage > 1 && <Link href={`/payments?page=${validPage - 1}`} className="underline">Previous</Link>}
        {(tipRows.length > PAGE_SIZE || plans?.hasMore) && <Link href={`/payments?page=${validPage + 1}`} className="underline">Next</Link>}
      </nav>
    </main>
  );
}
