/** Safe response contract only. No private terms, provider evidence, card data,
 * payment URLs or customer/PaymentIntent IDs belong in this client DTO. */
export type ExactAdminPlan = Readonly<{
  id: string;
  title: string;
  status: string;
  totalCents: number;
  paymentCount: number;
  purchaseId: string | null;
  holds: string[];
  recoveries: Array<{ outcome: string; observedAt: string | null }>;
  stop: { requestId: string; status: "requested" | "running" | "complete"; ownedByCaller: boolean } | null;
}>;
export type ExactAdminPage = Readonly<{ plans: ExactAdminPlan[]; nextCursor: string | null }>;
