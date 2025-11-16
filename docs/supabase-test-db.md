# Supabase Test Database README

Use this guide whenever you need to mirror production into a relaxed “test” Supabase project.  
It describes **what schema objects must exist**, **how to clone them**, and **how to toggle the app between test and production safely**.

---

## 1. What the test DB must contain

In addition to the core `profiles`, `posts`, `products`, `bookings`, etc., the test database needs the custom pieces we added for CreatorNet:

| Area | Objects |
| --- | --- |
| Commerce & bookings | `booking_payments` table with enums `booking_payment_plan` (`full`, `installment`) and `booking_payment_status` (`pending`, `link_sent`, `completed`, `canceled`, `refunded`) |
| Follow/feeds | `follows` table, RPCs `get_feed_discover(uuid, integer)` and `get_feed_following(uuid, integer)` returning `is_following` |
| Ratings | RPCs `set_profile_rating(profile_id, reviewer_id, rating)` and `get_profile_rating(profile_id)` plus `profiles.review_rating` & `profiles.review_count` columns |
| Misc | Storage bucket `avatars` (public), policies that allow signed-in users to read/write their own profile & avatar |

Keep these in sync when recreating the environment.

---

## 2. Export production schema

You only need to do this when the production schema changed since your last export.

```bash
"C:\Program Files\PostgreSQL\17\bin\pg_dump.exe" ^
  --schema-only ^
  --host=<prod-host>.supabase.co ^
  --port=5432 ^
  --username=postgres ^
  --dbname=postgres ^
  > schema.sql
```

Tips:
- Use PostgreSQL 17 tools (Supabase is on v17.6).
- When prompted, paste the DB password from Supabase → **Project Settings → Database**.
- This exports everything under `public`. If you only need specific objects you can limit with `--table`.

---

## 3. Import into the test project

```bash
"C:\Program Files\PostgreSQL\17\bin\psql.exe" ^
  -h <test-host>.supabase.co ^
  -p 5432 ^
  -d postgres ^
  -U postgres ^
  -f schema.sql
```

Ignore “already exists” warnings if you are re-importing. When permissions fail for Supabase system schemas, just keep the lines related to `public`.

---

## 4. Apply CreatorNet-specific SQL

After the base schema is in, run the snippets below (or keep them in a separate `.sql` file).

### Booking payments
```sql
create type if not exists public.booking_payment_plan as enum ('full','installment');
create type if not exists public.booking_payment_status as enum
  ('pending','link_sent','completed','canceled','refunded');

create table if not exists public.booking_payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  product_id uuid not null references public.products(product_id),
  closer_user_id uuid not null references auth.users(id),
  buyer_id uuid references auth.users(id),
  plan_type public.booking_payment_plan not null,
  installment_months integer check (installment_months is null or installment_months > 0),
  stripe_checkout_session_id text unique,
  stripe_price_id text,
  stripe_payment_intent_id text,
  stripe_subscription_id text,
  link_url text,
  status public.booking_payment_status not null default 'pending',
  amount_total_cents bigint,
  installment_amount_cents bigint,
  platform_fee_cents bigint,
  currency char(3) not null default 'usd',
  notes jsonb,
  completed_at timestamptz,
  link_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_booking_payments_booking_id on public.booking_payments(booking_id);
create index if not exists idx_booking_payments_closer_user on public.booking_payments(closer_user_id);
create index if not exists idx_booking_payments_status on public.booking_payments(status);
```

### Feed RPCs
Recreate `get_feed_discover` and `get_feed_following` with the same signature as production (include `is_following`). Use `DROP FUNCTION IF EXISTS ...` before `CREATE OR REPLACE FUNCTION ...`.

### Profile ratings
```sql
alter table public.profiles
  add column if not exists review_rating numeric default 0,
  add column if not exists review_count integer default 0;
```
Create or replace the `set_profile_rating` and `get_profile_rating` RPCs matching production logic.

---

## 5. Seed data for testing

- Run `supabase/seed_bookings.sql` to insert a sample booking + mentorship product.
- Manually insert at least one creator profile, one buyer profile, and a few posts pointing to valid `products.product_id`.
- For Stripe tests, create prices in Stripe **test mode** and store their IDs in `products.stripe_price_id`.

---

## 6. Relax RLS (optional)

On the test project you can disable Row Level Security for faster iteration:
1. Table → `Policies`.
2. Toggle RLS off or add `USING (true)`/`WITH CHECK (true)` policies.
3. Keep production RLS untouched.

---

## 7. Point the app to the test DB

1. Duplicate your prod env file: `copy .env.local .env.prod`.
2. Create `.env.test` with the test project URL/keys.
3. When you want to run against test, overwrite `.env.local`:
   ```bash
   copy /Y .env.test .env.local
   npm run dev
   ```
4. The app will now use the relaxed Supabase project.

---

## 8. Switch back to production

1. Restore `.env.local` with the production values (the ones currently checked in should point to prod).
2. Re-run `npm run dev`.
3. Confirm the dashboard loads real data.
4. Revert any temporary code hacks with `git checkout -- <file>` if needed.

---

## 9. Sanity checklist

- [ ] `git status` is clean (only intentional changes).
- [ ] `.env.local` matches production.
- [ ] Supabase test project still has permissive settings; production remains locked down.
- [ ] Booking flow works end-to-end (Buy, Book, Closer payment link).
- [ ] Profile ratings persist (RPCs deployed).

Keep this document with the repo so anyone on the team can reproduce the test DB without touching production. When in doubt, export from production again instead of editing production directly.
