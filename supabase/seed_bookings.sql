-- Fetch IDs to use in the inserts (run these SELECTs first)
-- 1. Choose creator, buyer, post
-- select id, email from auth.users;                 -- list users
-- select id, username from profiles;                -- list profiles
-- select id, creator_id, title from posts limit 10; -- list posts

-- Seed booking tied to product  aac8e6b3-dc74-4b29-9c34-777bbb169a41
delete from public.booking_payments;
delete from public.bookings;

insert into public.bookings (id, post_id, buyer_id, creator_id, status, created_at)
values (
  gen_random_uuid(),
  '01432b67-63eb-476c-9718-8b75175a12fa',
  '2e447493-2606-4446-a31c-968c29b55cef',
  'da446e1e-6e2e-442b-9ec8-fc9b2a20ff94',
  'booked',
  now()
);

update public.posts
set
  product_id = 'aac8e6b3-dc74-4b29-9c34-777bbb169a41',
  product_type = 'mentorship',
  cta_type = 'closer'
where id = '01432b67-63eb-476c-9718-8b75175a12fa';

select id, post_id, buyer_id, creator_id, status, created_at
from public.bookings
order by created_at desc
limit 5;
