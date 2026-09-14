import {createMockClient} from './__mocks__/supabaseQueryMock';
import {bookingLeadStatus,readBookingSchedulingStatus} from '@/lib/bookingSchedulingStatus';
const bookings=[{id:'lead-a',buyer_id:'buyer-a',post_id:'post-a'},{id:'lead-b',buyer_id:'buyer-b',post_id:'post-b'}];
const base={user_id:'buyer-a',post_id:'post-a',provider:'calendly',provider_booking_id:'remote',verified_at:'2026-09-14',scheduled_at:'2026-09-15T16:00:00Z',canceled_at:null};
test('setup is not scheduled, rescheduling uses the current time, and cancellation remains separate from payment',async()=>{
 const db=createMockClient(()=>({data:[
  {...base,id:'setup',provider:null,provider_booking_id:null,verified_at:null},
  {...base,id:'scheduled'},
  {...base,id:'canceled',canceled_at:'2026-09-14'},
  {...base,id:'cross-pair',post_id:'post-b'},
 ],error:null}));
 const result=await readBookingSchedulingStatus(db as never,'creator',bookings);
 expect(result.get('lead-a')?.map(x=>x.status)).toEqual(['awaiting_confirmation','scheduled','canceled']);
 expect(result.get('lead-a')?.[0].scheduledAt).toBeNull();
 expect(result.get('lead-a')?.[1].scheduledAt).toBe(base.scheduled_at);
 expect(result.get('lead-b')).toEqual([]);
 expect(db.ops[0].filters.creator_id).toBe('creator');
 expect(bookingLeadStatus('booked')).toBe('Lead saved');
 expect(bookingLeadStatus('completed')).toBe('Payment completed');
});
test('activity pagination does not silently lose the latest receipt beyond the first batch',async()=>{
 const rows=Array.from({length:201},(_,i)=>({...base,id:String(i).padStart(4,'0')}));
 const db=createMockClient(op=>({data:rows.filter(x=>x.id>String(op.filters.cursor??'')).slice(0,200),error:null}));
 const from=db.from;
 db.from=table=>{const source=from(table);return {...source,select:(columns:string)=>{const chain=source.select(columns);chain.gt=(_:string,value:string)=>chain.eq('cursor',value);return chain;}};};
 const result=await readBookingSchedulingStatus(db as never,'creator',bookings);
 expect(result.get('lead-a')).toHaveLength(201);expect(db.ops).toHaveLength(2);
});
test('unavailable scheduling evidence fails rather than presenting an unconfirmed result as current',async()=>{
 const db=createMockClient(()=>({data:null,error:new Error('offline')}));
 await expect(readBookingSchedulingStatus(db as never,'creator',bookings)).rejects.toThrow('offline');
});
