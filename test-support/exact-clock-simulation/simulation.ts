import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calculateInstallmentPlan } from "../../lib/installmentPlan";
import { installmentMonthBoundary } from "../../lib/installments/checkoutPreparation";
import type { ProcessingFeeSchedule } from "../../lib/money";
import { assertFreshExactClockObservation, type ExactClockObservation } from "./clockEvidence";
import { assertExactClockMemoryDatabase, createExactClockMemoryDatabase } from "./isolation";

/** NEW temporal model; NOT installed runtime/043 acceptance. This cannot pay,
 * deploy, import a hosted agreement, issue access, or connect to a database.
 * Provider-shaped values and receipts here must use explicitly dummy IDs. */
const KIND = "simulation-only-new-temporal-model" as const;
const failure = () => new Error("Local clock simulation stopped");
function ensure(value: unknown): asserts value { if (!value) throw failure(); }
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;

export type SimulatedAdmission = Readonly<{
  kind: typeof KIND;
  id: string;
  installmentNumber: number;
  billingTimeSeconds: number;
  dispatchWallTimeMilliseconds: number;
}>;
export type SimulatedReceipt = Readonly<{
  invoiceId: string;
  paymentIntentId: string;
  chargeId: string;
  grossCents: number;
  deductionCents: number;
  /** Original supplied value is stored verbatim; never shifted to clock time. */
  rawCaptureSeconds: number;
}>;
type State = {
  identity: unknown;
  revision: number;
  held: boolean;
  stopped: boolean;
  last_billing_time: number;
  last_observed_wall_ms: number;
};
type Period = { number: number; starts_at: number; ends_at: number; gross_cents: number; deduction_cents: number };

function receiptSnapshot(value: unknown): SimulatedReceipt {
  try {
    ensure(value && typeof value === "object" && !Array.isArray(value));
    ensure(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    const names = ["invoiceId", "paymentIntentId", "chargeId", "grossCents", "deductionCents", "rawCaptureSeconds"] as const;
    ensure(Reflect.ownKeys(value).length === names.length);
    const result: Record<string, unknown> = {};
    for (const name of names) {
      const d = Object.getOwnPropertyDescriptor(value, name);
      ensure(d && "value" in d && d.enumerable);
      ensure(typeof d.value === "string" || typeof d.value === "number");
      result[name] = d.value;
    }
    return Object.freeze(result) as SimulatedReceipt;
  } catch { throw failure(); }
}

function identity(o: ExactClockObservation) {
  return { context: o.context, simulationId: o.simulationId,
    clockId: o.clockId, customerId: o.customerId, subscriptionId: o.subscriptionId };
}
function sameIdentity(stored: unknown, observation: ExactClockObservation) {
  // JSONB object key order is not a binding; compare the fixed field projection.
  const a = stored as ReturnType<typeof identity>;
  const b = identity(observation);
  return a.simulationId === b.simulationId && a.clockId === b.clockId &&
    a.customerId === b.customerId && a.subscriptionId === b.subscriptionId &&
    (Object.keys(b.context) as Array<keyof typeof b.context>).every(key => a.context[key] === b.context[key]);
}

export async function createExactClockSimulation(args: {
  firstObservation: ExactClockObservation;
  totalCents: number;
  paymentCount: number;
  firstFeeSchedule: ProcessingFeeSchedule;
  renewalFeeSchedule: ProcessingFeeSchedule;
}) {
  assertFreshExactClockObservation(args.firstObservation);
  const first = args.firstObservation;
  ensure(first.context.mode === "test");
  for (const [value, prefix] of [[first.clockId, "clock"], [first.customerId, "cus"],
    [first.subscriptionId, "sub"]]) ensure(new RegExp(`^${prefix}_CNQALOCAL[A-Za-z0-9]+$`).test(value));
  const plan = calculateInstallmentPlan(args.totalCents, args.paymentCount,
    args.renewalFeeSchedule, args.firstFeeSchedule);
  const anchor = first.billingTimeSeconds;
  const fixedEnd = installmentMonthBoundary(anchor, plan.paymentCount);
  const db = await createExactClockMemoryDatabase();
  assertExactClockMemoryDatabase(db);
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const consumed = new WeakSet<object>();
  const admitted = new WeakSet<object>();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };
  async function transaction<T>(work: () => Promise<T>): Promise<T> {
    ensure(!closed);
    assertExactClockMemoryDatabase(db);
    await db.exec("begin");
    try { const result = await work(); await db.exec("commit"); return result; }
    catch { await db.exec("rollback"); throw failure(); }
  }
  const wallNow = async () => Number((await db.query<{ ms: number }>(
    "select extract(epoch from clock_timestamp()) * 1000 as ms")).rows[0].ms);
  const state = async () => (await db.query<State>("select * from cnqa_clock_v1.fixture for update")).rows[0];
  async function checkObservation(o: ExactClockObservation, s: State) {
    assertFreshExactClockObservation(o);
    ensure(!consumed.has(o) && sameIdentity(s.identity, o));
    const now = await wallNow();
    ensure(now >= o.observedWallTimeMilliseconds && now - o.startedWallTimeMilliseconds <= 30_000);
    ensure(o.observedWallTimeMilliseconds >= Number(s.last_observed_wall_ms));
    ensure(o.billingTimeSeconds >= Number(s.last_billing_time));
  }
  const bump = () => db.exec("update cnqa_clock_v1.fixture set revision = revision + 1");
  const creditCount = async () => Number((await db.query<{ count: number }>(
    "select count(*) as count from cnqa_clock_v1.receipt")).rows[0].count);

  try {
    await db.exec(readFileSync(join(__dirname, "schema.sql"), "utf8"));
    await transaction(async () => {
      const now = await wallNow();
      ensure(now >= first.observedWallTimeMilliseconds && now - first.startedWallTimeMilliseconds <= 30_000);
      await db.query(`insert into cnqa_clock_v1.fixture
        (simulation_id, identity, total_cents, payment_count, fixed_end, last_billing_time, last_observed_wall_ms)
        values ($1,$2,$3,$4,$5,$6,$7)`, [first.simulationId, identity(first), plan.totalCents,
        plan.paymentCount, fixedEnd, anchor, first.observedWallTimeMilliseconds]);
      for (const p of plan.payments) await db.query(`insert into cnqa_clock_v1.period
        (number, starts_at, ends_at, gross_cents, deduction_cents) values ($1,$2,$3,$4,$5)`,
      [p.number, installmentMonthBoundary(anchor, p.number - 1), installmentMonthBoundary(anchor, p.number),
        p.amountCents, p.fees.totalCreatorDeductionCents]);
    });
  } catch { await db.close(); throw failure(); }

  return Object.freeze({
    kind: KIND,
    plan,
    /** Separate logical billing clock; this does not alter provider or DB time. */
    async admit(o: ExactClockObservation, installmentNumber: number, expectedRevision: number) {
      return serial(async () => {
        const result = await transaction(async () => {
          const s = await state();
          ensure(Number.isSafeInteger(expectedRevision) && s.revision === expectedRevision);
          await checkObservation(o, s);
          ensure(!s.held && !s.stopped && positive(installmentNumber) && installmentNumber <= plan.paymentCount);
          ensure(await creditCount() === installmentNumber - 1);
          const p = (await db.query<Period>("select * from cnqa_clock_v1.period where number=$1", [installmentNumber])).rows[0];
          ensure(p && o.billingTimeSeconds >= Number(p.starts_at) && o.billingTimeSeconds < Number(p.ends_at));
          // Unique period row prevents all second admissions, including after
          // an unknown outcome. No payment port or worker lease is modeled.
          const id = randomUUID();
          // Recheck freshness in the insertion statement, not only before an
          // await. Dispatch wall time is generated by that same DB statement.
          const inserted = await db.query<{ dispatch_wall_ms: number }>(`
            with observed as materialized (select extract(epoch from clock_timestamp()) * 1000 as wall_ms)
            insert into cnqa_clock_v1.admission
            (id, number, observation, billing_time, dispatch_wall_ms, outcome)
            select $1,$2,$3,$4,observed.wall_ms,'admitted' from observed
            where observed.wall_ms >= $5 and observed.wall_ms - $6 <= 30000
            returning dispatch_wall_ms`, [id, installmentNumber, o, o.billingTimeSeconds,
            o.observedWallTimeMilliseconds, o.startedWallTimeMilliseconds]);
          ensure(inserted.rows.length === 1);
          const a: SimulatedAdmission = Object.freeze({ kind: KIND, id, installmentNumber,
            billingTimeSeconds: o.billingTimeSeconds,
            dispatchWallTimeMilliseconds: Number(inserted.rows[0].dispatch_wall_ms) });
          await db.query(`update cnqa_clock_v1.fixture set last_billing_time=$1,
            last_observed_wall_ms=$2, revision=revision+1`, [o.billingTimeSeconds, o.observedWallTimeMilliseconds]);
          return a;
        });
        consumed.add(o);
        admitted.add(result);
        return result;
      });
    },
    async markOutcomeUnknown(a: SimulatedAdmission) {
      return serial(() => transaction(async () => {
        ensure(admitted.has(a));
        const rows = (await db.query("update cnqa_clock_v1.admission set outcome='unknown' where id=$1 and outcome='admitted' returning id", [a.id])).rows;
        ensure(rows.length === 1);
        await bump();
      }));
    },
    /** Local receipt simulation, not provider settlement or financial credit.
     * Reconcile ONLY the original admission, including after hold/stop. */
    async recordReceipt(a: SimulatedAdmission, supplied: SimulatedReceipt) {
      // Snapshot only scalar fields before queueing; no later caller mutation.
      const r = receiptSnapshot(supplied);
      return serial(() => transaction(async () => {
        ensure(admitted.has(a));
        for (const [value, prefix] of [[r.invoiceId, "in"], [r.paymentIntentId, "pi"], [r.chargeId, "ch"]]) {
          ensure(typeof value === "string" && new RegExp(`^${prefix}_CNQALOCAL[A-Za-z0-9]+$`).test(value));
        }
        ensure(positive(r.rawCaptureSeconds) && positive(r.grossCents) &&
          Number.isSafeInteger(r.deductionCents) && r.deductionCents >= 0);
        const p = (await db.query<Period>("select * from cnqa_clock_v1.period where number=$1", [a.installmentNumber])).rows[0];
        ensure(r.grossCents === Number(p.gross_cents) && r.deductionCents === Number(p.deduction_cents));
        const now = await wallNow();
        ensure(r.rawCaptureSeconds * 1000 >= a.dispatchWallTimeMilliseconds - 1000 && r.rawCaptureSeconds * 1000 <= now);
        const existing = (await db.query<Record<string, unknown>>("select * from cnqa_clock_v1.receipt where admission_id=$1", [a.id])).rows[0];
        if (existing) {
          ensure(existing.invoice_id === r.invoiceId && existing.payment_intent_id === r.paymentIntentId &&
            existing.charge_id === r.chargeId && Number(existing.gross_cents) === r.grossCents &&
            Number(existing.deduction_cents) === r.deductionCents && Number(existing.raw_capture_seconds) === r.rawCaptureSeconds);
          return Object.freeze({ kind: KIND, credited: false, duplicate: true });
        }
        await db.query(`insert into cnqa_clock_v1.receipt
          (admission_id,invoice_id,payment_intent_id,charge_id,gross_cents,deduction_cents,raw_capture_seconds)
          values ($1,$2,$3,$4,$5,$6,$7)`, [a.id,r.invoiceId,r.paymentIntentId,r.chargeId,r.grossCents,r.deductionCents,r.rawCaptureSeconds]);
        await db.query("update cnqa_clock_v1.admission set outcome='credited' where id=$1", [a.id]);
        await bump();
        return Object.freeze({ kind: KIND, credited: true, duplicate: false });
      }));
    },
    async setHold(held: boolean) {
      return serial(() => transaction(async () => {
        ensure(typeof held === "boolean");
        await db.query("update cnqa_clock_v1.fixture set held=$1,revision=revision+1", [held]);
      }));
    },
    async stop() {
      return serial(() => transaction(async () => {
        await db.exec("update cnqa_clock_v1.fixture set stopped=true,revision=revision+1");
      }));
    },
    async snapshot() {
      return serial(() => transaction(async () => {
        const s = await state();
        const paidCount = await creditCount();
        const totals = (await db.query<{ gross: number; deduction: number }>(`select
          coalesce(sum(gross_cents),0) as gross,coalesce(sum(deduction_cents),0) as deduction from cnqa_clock_v1.receipt`)).rows[0];
        const admissions = (await db.query<{ number: number; outcome: string; billing_time: number; dispatch_wall_ms: number; raw_capture_seconds: number | null }>(`
          select a.number,a.outcome,a.billing_time,a.dispatch_wall_ms,r.raw_capture_seconds
          from cnqa_clock_v1.admission a left join cnqa_clock_v1.receipt r on r.admission_id=a.id order by a.number`)).rows;
        return Object.freeze({ kind: KIND, revision: s.revision, held: s.held, stopped: s.stopped,
          paidCount, complete: paidCount === plan.paymentCount, fixedEndBillingSeconds: fixedEnd,
          grossCents: Number(totals.gross), deductionCents: Number(totals.deduction),
          admissions: Object.freeze(admissions.map(row => Object.freeze({ installmentNumber: row.number,
            outcome: row.outcome, billingTimeSeconds: Number(row.billing_time),
            dispatchWallTimeMilliseconds: Number(row.dispatch_wall_ms),
            rawCaptureSeconds: row.raw_capture_seconds === null ? null : Number(row.raw_capture_seconds) }))) });
      }));
    },
    async close() {
      return serial(async () => { if (!closed) { closed = true; await db.close(); } });
    },
  });
}
