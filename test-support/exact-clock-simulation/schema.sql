-- LOCAL SIMULATION ONLY. Not an application migration or financial ledger.
-- Loaded only into a newly owned, in-memory database. Wall time is never reset.
create schema cnqa_clock_v1;

create table cnqa_clock_v1.fixture (
  singleton boolean primary key default true check (singleton),
  simulation_id uuid not null,
  identity jsonb not null,
  total_cents bigint not null check (total_cents > 0),
  payment_count integer not null check (payment_count between 2 and 24),
  fixed_end bigint not null,
  last_billing_time bigint not null,
  last_observed_wall_ms double precision not null,
  revision integer not null default 0 check (revision >= 0),
  held boolean not null default false,
  stopped boolean not null default false,
  created_wall_at timestamptz not null default clock_timestamp()
);

create table cnqa_clock_v1.period (
  number integer primary key,
  starts_at bigint not null,
  ends_at bigint not null check (ends_at > starts_at),
  gross_cents bigint not null check (gross_cents > 0),
  deduction_cents bigint not null check (deduction_cents >= 0 and deduction_cents <= gross_cents)
);

create table cnqa_clock_v1.admission (
  id uuid primary key,
  number integer not null unique references cnqa_clock_v1.period(number),
  observation jsonb not null,
  billing_time bigint not null,
  dispatch_wall_ms double precision not null,
  outcome text not null check (outcome in ('admitted', 'unknown', 'credited'))
);

create table cnqa_clock_v1.receipt (
  admission_id uuid primary key references cnqa_clock_v1.admission(id),
  invoice_id text not null unique check (invoice_id ~ '^in_CNQALOCAL[A-Za-z0-9]+$'),
  payment_intent_id text not null unique check (payment_intent_id ~ '^pi_CNQALOCAL[A-Za-z0-9]+$'),
  charge_id text not null unique check (charge_id ~ '^ch_CNQALOCAL[A-Za-z0-9]+$'),
  gross_cents bigint not null,
  deduction_cents bigint not null,
  raw_capture_seconds bigint not null,
  recorded_wall_at timestamptz not null default clock_timestamp()
);
