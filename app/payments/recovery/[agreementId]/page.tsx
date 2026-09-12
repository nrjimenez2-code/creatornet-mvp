import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { assertAgreementId } from "@/lib/installments/agreementStore";
import { buyerRecoveryEnabled } from "@/lib/installments/buyerRecovery";
import { buyerRecoveryController } from "@/lib/installments/buyerRecoveryServer";
import { PaymentRecovery } from "./PaymentRecovery";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Payment recovery", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function PaymentRecoveryPage({ params }: { params: Promise<{ agreementId: string }> }) {
  if (!buyerRecoveryEnabled(process.env)) notFound();
  const { agreementId } = await params;
  try { assertAgreementId(agreementId); } catch { notFound(); }
  const user = await getAuthenticatedUser();
  if (!user) redirect(`/auth?next=${encodeURIComponent(`/payments/recovery/${agreementId}`)}`);
  let initial;
  try { initial = await buyerRecoveryController().read(agreementId, user.id); }
  catch { notFound(); }
  return <PaymentRecovery initial={initial} />;
}
