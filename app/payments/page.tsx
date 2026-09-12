import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { buyerRecoveryEnabled } from "@/lib/installments/buyerRecovery";
import { listBuyerPaymentPlans } from "@/lib/installments/buyerPlanList";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your payment plans", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function PaymentPlansPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const user = await getAuthenticatedUser();
  if (!user) redirect("/auth?next=%2Fpayments");
  const query = await searchParams, page = Number(query.page || "1");
  let result: Awaited<ReturnType<typeof listBuyerPaymentPlans>> | null = null;
  if (buyerRecoveryEnabled(process.env)) {
    try {
      const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false, autoRefreshToken: false } });
      result = await listBuyerPaymentPlans(admin, user.id, page, process.env);
    } catch { /* No provider, credential or other buyer's data is rendered. */ }
  }
  return <main className="mx-auto max-w-3xl p-6 text-white">
    <Link href="/library" className="text-sm underline">Back to your library</Link>
    <h1 className="mt-6 text-2xl font-semibold">Your payment plans</h1>
    <p className="mt-2 text-sm text-gray-400">Review your installment payments here. Content access and payment obligations are separate.</p>
    {result === null ? <p role="alert" className="mt-6">Payment review is unavailable right now. For help, contact <a href="mailto:support@creatornet.net" className="underline">support@creatornet.net</a>.</p> : <>
      {result.plans.length === 0 && <p className="mt-6">No installment plans are available for review on this page.</p>}
      <ul className="mt-6 space-y-3">{result.plans.map(plan => <li key={plan.id} className="rounded-xl border border-gray-700 p-4">
        <p className="font-medium">{plan.title}</p>
        <Link href={`/payments/recovery/${plan.id}`} className="mt-2 inline-block text-sm underline">Review payment plan</Link>
      </li>)}</ul>
      <nav aria-label="Payment plan pages" className="mt-6 flex gap-4 text-sm">
        {page > 1 && <Link href={`/payments?page=${page - 1}`} className="underline">Previous</Link>}
        {result.hasMore && <Link href={`/payments?page=${page + 1}`} className="underline">Next</Link>}
      </nav>
    </>}
  </main>;
}
