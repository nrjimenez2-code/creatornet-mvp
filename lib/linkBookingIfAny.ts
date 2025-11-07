// /lib/linkBookingIfAny.ts
import type { SupabaseClient } from '@supabase/supabase-js';

type LinkArgs = {
  supabase: SupabaseClient;
  buyerId: string;
  creatorId: string;
  postId?: string | null;
  orderId: string;           // the newly inserted order id
  lookbackDays?: number;     // default 14
};

export async function linkBookingIfAny({
  supabase,
  buyerId,
  creatorId,
  postId,
  orderId,
  lookbackDays = 14,
}: LinkArgs) {
  // find newest unmatched booking (optionally same post) in lookback window
  const { data: rows, error: findErr } = await supabase
    .from('bookings')
    .select('id, created_at, post_id')
    .eq('buyer_id', buyerId)
    .eq('creator_id', creatorId)
    .is('linked_order_id', null)
    .order('created_at', { ascending: false })
    .limit(8);

  if (findErr || !rows?.length) return;

  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  // prefer same-post match; otherwise take newest within window
  let candidate =
    (postId && rows.find(b => b.post_id === postId && new Date(b.created_at).getTime() >= cutoff)) ||
    rows.find(b => new Date(b.created_at).getTime() >= cutoff) ||
    null;

  if (!candidate) return;

  // attach both sides
  const { error: updOrderErr } = await supabase
    .from('orders')
    .update({ booking_id: candidate.id })
    .eq('id', orderId);
  if (updOrderErr) {
    console.error('orders.booking_id update failed', updOrderErr);
    return;
  }

  const { error: updBookingErr } = await supabase
    .from('bookings')
    .update({ linked_order_id: orderId, status: 'completed' })
    .eq('id', candidate.id);
  if (updBookingErr) {
    console.error('bookings.linked_order_id update failed', updBookingErr);
  }
}
