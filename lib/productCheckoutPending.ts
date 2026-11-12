import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Existing pending-purchase compare-and-set path shared by creation and original recovery. */
export async function writeProductCheckoutPending(args:{admin:SupabaseClient;buyerId:string|null;sessionId:string;
 amountCents:number;currency:string;orderId:string|null;creatorId:string|null;postId:string|null;productId:string;
 reusablePurchaseId:string|null;expectedPriorSessionId:string|null}):Promise<boolean>{
 const {admin:supabase,buyerId,sessionId:session_id,amountCents:amount_cents,currency,orderId:order_id,
 creatorId,postId,productId,reusablePurchaseId,expectedPriorSessionId}=args;
 const isUniqueViolation=(error:{code?:string}|null)=>error?.code==="23505";

    const insert: Record<string, unknown> = {
      session_id,
      status: "pending",
      product_id: productId,
      post_id: postId,
      creator_id: creatorId,
      buyer_id: buyerId,
      amount_cents,
      currency,
    };
    if (order_id) insert.order_id = order_id;
    if (buyerId) {
      insert.buyer_user_id = buyerId;
    }

    const loadWinner = async () => {
      const identityColumn = postId ? "post_id" : "product_id";
      const identityValue = postId || productId;
      const { data, error } = await supabase
        .from("purchases")
        .select("id, status, session_id, order_id")
        .eq("buyer_id", buyerId)
        .eq(identityColumn, identityValue)
        .or("kind.is.null,kind.neq.monthly_mentorship_v1,status.is.null,status.neq.canceled")
        .maybeSingle();
      if (error) {
        throw new Error(`Failed to verify checkout winner: ${error.message}`);
      }
      return data as
        | { id: string; status: string; session_id: string | null; order_id: string | null }
        | null;
    };

    if (reusablePurchaseId) {
      let update = supabase
        .from("purchases")
        .update(insert)
        .eq("id", reusablePurchaseId)
        .in("status", ["pending", "processing", "failed"]);
      update = expectedPriorSessionId
        ? update.eq("session_id", expectedPriorSessionId)
        : update.is("session_id", null);
      const { data, error } = await update
        .select("id")
        .maybeSingle();
      if (error) {
        throw new Error(
          `Failed to reuse pending purchase: ${error.message}`
        );
      }
      if (data?.id) return true;

      const winner = await loadWinner();
      return Boolean(winner && winner.session_id === session_id && winner.order_id === order_id);
    }

    const { error } = await supabase.from("purchases").insert(insert).select("id").single();
    if (!error) return true;
    if (!isUniqueViolation(error)) {
      throw new Error(`Failed to write pending purchase: ${error.message}`);
    }

    // A simultaneous request can win the buyer/product uniqueness constraint.
    // It is safe only when Stripe returned the same idempotent session to both.
    const winner = await loadWinner();
    return Boolean(winner && winner.session_id === session_id && winner.order_id === order_id);
}
