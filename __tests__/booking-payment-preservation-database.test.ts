/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

declare const createLocalPostgres: () => PGlite;
const migration = readFileSync("supabase/migrations/20261023015433_preserve_booking_payment_history.sql", "utf8");
let db: PGlite;
jest.setTimeout(90000);

beforeEach(async () => {
  db = createLocalPostgres();
  await db.exec(`
    create table public.bookings (id int primary key);
    create table public.booking_payments (
      id int primary key, booking_id int,
      constraint booking_payments_booking_id_fkey foreign key (booking_id)
        references public.bookings(id) on delete cascade
    );
    create table public.payment_fee_ledger (
      id int primary key, booking_payment_id int references public.booking_payments(id) on delete set null
    );
    insert into public.bookings values (1),(2);
    insert into public.booking_payments values (10,1);
    insert into public.payment_fee_ledger values (100,10);
  `);
});
afterEach(async () => { await db.close(); });

test("migration preserves all rows and replaces only the deletion action", async () => {
  await db.exec(migration);
  expect((await db.query("select confdeltype,confupdtype,confmatchtype,condeferrable,condeferred,convalidated from pg_constraint where conname='booking_payments_booking_id_fkey'" )).rows)
    .toEqual([{ confdeltype: "r", confupdtype: "a", confmatchtype: "s", condeferrable: false, condeferred: false, convalidated: true }]);
  await expect(db.exec("delete from public.bookings where id=1")).rejects.toMatchObject({ code: "23001" });
  expect((await db.query("select * from public.bookings order by id")).rows).toEqual([{ id: 1 }, { id: 2 }]);
  expect((await db.query("select * from public.booking_payments")).rows).toEqual([{ id: 10, booking_id: 1 }]);
  expect((await db.query("select * from public.payment_fee_ledger")).rows).toEqual([{ id: 100, booking_payment_id: 10 }]);
});

test("a payment inserted after the route's empty check still prevents deletion", async () => {
  await db.exec(migration);
  expect((await db.query("select id from public.booking_payments where booking_id=2")).rows).toEqual([]);
  await db.exec("insert into public.booking_payments values(20,2)");
  await expect(db.exec("delete from public.bookings where id=2")).rejects.toMatchObject({ code: "23001" });
  expect((await db.query("select id from public.booking_payments where booking_id=2")).rows).toEqual([{ id: 20 }]);
});

test("a booking without payments can be deleted; later payment insertion fails", async () => {
  await db.exec(migration);
  await db.exec("delete from public.bookings where id=2");
  await expect(db.exec("insert into public.booking_payments values(20,2)")).rejects.toMatchObject({ code: "23503" });
});

test("unexpected FK update behavior fails closed without replacing the constraint", async () => {
  await db.exec(`alter table public.booking_payments drop constraint booking_payments_booking_id_fkey,
    add constraint booking_payments_booking_id_fkey foreign key(booking_id) references public.bookings(id)
      on update cascade on delete cascade;`);
  await expect(db.exec(migration)).rejects.toThrow("differs from the reviewed CASCADE relationship");
  await db.exec("rollback");
  expect((await db.query("select confdeltype,confupdtype from pg_constraint where conname='booking_payments_booking_id_fkey'")).rows)
    .toEqual([{ confdeltype: "c", confupdtype: "c" }]);
  expect((await db.query("select * from public.payment_fee_ledger")).rows).toEqual([{ id: 100, booking_payment_id: 10 }]);
});
