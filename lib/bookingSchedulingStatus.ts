import type { SupabaseClient } from '@supabase/supabase-js';

export type BookingSchedulingActivity = {
  id: string;
  provider: string | null;
  status: 'awaiting_confirmation' | 'scheduled' | 'canceled';
  scheduledAt: string | null;
};
export const bookingLeadStatus = (status: string) => status === 'booked' ? 'Lead saved'
  : status === 'completed' ? 'Payment completed' : status.replace(/_/g, ' ');
const key = (buyer: string, post: string) => JSON.stringify([buyer, post]);

// Legacy lead rows have no one-to-one provider booking ID. Report all verified
// activity for the exact buyer/video pair instead of guessing which call they mean.
export async function readBookingSchedulingStatus(db: SupabaseClient, creator: string,
  bookings: { id: string; buyer_id: string; post_id: string }[]) {
  const result = new Map<string, BookingSchedulingActivity[]>();
  if (!bookings.length) return result;
  const pairs = new Map<string, BookingSchedulingActivity[]>();
  for (const booking of bookings) pairs.set(key(booking.buyer_id, booking.post_id), []);
  let cursor: string | null = null;
  for (;;) {
    let query = db.from('discover_booking_attribution_v1')
      .select('id,user_id,post_id,provider,provider_booking_id,verified_at,scheduled_at,canceled_at')
      .eq('creator_id', creator)
      .in('user_id', [...new Set(bookings.map(b => b.buyer_id))])
      .in('post_id', [...new Set(bookings.map(b => b.post_id))])
      .order('id').limit(200);
    if (cursor) query = query.gt('id', cursor);
    const {data, error} = await query;
    if (error) throw error;
    for (const row of data ?? []) {
      const activity = pairs.get(key(row.user_id, row.post_id));
      if (!activity) continue;
      const verified = !!(row.verified_at && row.provider && row.provider_booking_id && row.scheduled_at);
      activity.push({id:row.id, provider:row.provider, status:row.canceled_at ? 'canceled' : verified ? 'scheduled' : 'awaiting_confirmation', scheduledAt:verified ? row.scheduled_at : null});
    }
    if (!data || data.length < 200) break;
    cursor = data[data.length-1].id;
  }
  for (const booking of bookings) result.set(booking.id, pairs.get(key(booking.buyer_id,booking.post_id)) ?? []);
  return result;
}
