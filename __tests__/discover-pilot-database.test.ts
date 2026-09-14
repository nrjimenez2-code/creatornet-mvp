/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
declare const createLocalPostgres:()=>PGlite;
let db:PGlite;
const viewer='11111111-1111-4111-8111-111111111111';
const quiet='22222222-2222-4222-8222-222222222222';
jest.setTimeout(90000);
beforeAll(async()=>{
 db=createLocalPostgres();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key);
 insert into auth.users values('${viewer}'),('${quiet}');
 create table discover_sessions_v1(id uuid,tab text,user_id uuid);
 create table discover_events_v1(id uuid default gen_random_uuid(),user_id uuid,post_id uuid,creator_id uuid,kind text,valid boolean default true,occurred_at timestamptz,amount_cents bigint default 0,currency text);
 grant select on discover_events_v1 to service_role;`);
 await db.exec(readFileSync('supabase/migrations/20260914093000_discover_controlled_pilot.sql','utf8'));
 await db.exec(`insert into discover_pilots_v1 values('trial','commercial-order-v1','2026-09-01','2026-09-15',true,30,'Test protocol',array['${viewer}','${quiet}']::uuid[]);
 insert into discover_pilot_assignments_v1 values('trial','${viewer}','commercial','2026-09-10'),('trial','${quiet}','control','2026-09-10');
 insert into discover_events_v1(user_id,kind,occurred_at,amount_cents,currency) values
 ('${viewer}','purchase','2026-09-09',999,'usd'),
 ('${viewer}','purchase','2026-09-20',12000,'usd'),
 ('${viewer}','mentorship_purchase','2026-09-21',5000,'eur'),
 ('${viewer}','purchase','2026-10-10',999,'usd');`);
});
afterAll(async()=>{await db.close();});
test('measurement retains zero-event viewers and delayed receipts without currency mixing',async()=>{
 const {rows}=await db.query<{user_id:string,purchases:number}>(`select user_id,purchases::int from discover_pilot_outcomes_v1 order by user_id`);
 expect(rows).toEqual([{user_id:viewer,purchases:2},{user_id:quiet,purchases:0}]);
 const money=await db.query(`select currency,net_amount_cents::int from discover_pilot_revenue_v1 order by currency`);
 expect(money.rows).toEqual([{currency:'eur',net_amount_cents:5000},{currency:'usd',net_amount_cents:12000}]);
 await db.exec(`update discover_events_v1 set valid=false where currency='eur'`);
 expect((await db.query(`select purchases::int from discover_pilot_outcomes_v1 where user_id='${viewer}'`)).rows).toEqual([{purchases:1}]);
});
test('client roles cannot read pilot data or enroll; service role cannot switch arms',async()=>{
 for(const role of ['anon','authenticated']){
  await db.exec('set role '+role);
  try {for(const table of ['discover_pilots_v1','discover_pilot_assignments_v1','discover_pilot_outcomes_v1','discover_pilot_revenue_v1'])
   await expect(db.query('select * from '+table)).rejects.toThrow(/permission denied/);
  }finally{await db.exec('reset role');}
 }
 await db.exec('set role service_role');
 try {
  await expect(db.exec(`update discover_pilot_assignments_v1 set variant='control' where user_id='${viewer}'`)).rejects.toThrow(/permission denied/);
  await db.exec(`insert into discover_pilot_assignments_v1 values('trial','${viewer}','control',now()) on conflict(experiment_id,user_id) do nothing`);
  expect((await db.query(`select variant from discover_pilot_assignments_v1 where user_id='${viewer}'`)).rows).toEqual([{variant:'commercial'}]);
 }finally{await db.exec('reset role');}
});
test('enrolled protocol is frozen while emergency stop remains available',async()=>{
 await expect(db.exec(`update discover_pilots_v1 set followup_days=1 where id='trial'`)).rejects.toThrow(/immutable/);
 await expect(db.exec(`update discover_pilots_v1 set eligible_user_ids='{}' where id='trial'`)).rejects.toThrow(/immutable/);
 await db.exec(`update discover_pilots_v1 set enabled=false where id='trial'`);
 expect((await db.query(`select enabled from discover_pilots_v1 where id='trial'`)).rows).toEqual([{enabled:false}]);
});
test('an unlisted viewer cannot enroll even through the service role',async()=>{
 await db.exec('set role service_role');
 try {
  await expect(db.exec(`insert into discover_pilot_assignments_v1 values('trial','33333333-3333-4333-8333-333333333333','control',now())`)).rejects.toThrow(/not eligible/);
 }finally{await db.exec('reset role');}
});
