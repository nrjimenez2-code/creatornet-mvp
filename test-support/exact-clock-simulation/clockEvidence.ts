import {
  assertStripeObjectMatchesExactContext,
  validateExactPaymentContext,
  type ExactPaymentContext,
} from "../../lib/installments/paymentContext";

/** Isolated simulation support only. No app route imports this module. The port
 * must be supplied by trusted server composition, never request/event metadata.
 * No SDK/client, environment, credential, database or mutation is used here. */
export const EXACT_CLOCK_OBSERVATION_MAX_AGE_MS = 30_000;

export type ExactClockBinding = Readonly<{
  version: "exact-clock-binding-v1";
  simulationId: string;
  clockId: string;
  customerId: string;
  subscriptionId: string;
}>;

/** Only independent provider reads belong in this port. Results are unknown so
 * malformed responses cannot obtain authority through TypeScript assertions. */
export interface ExactClockReadOnlyProvider {
  observePlatformAccount(): Promise<unknown>;
  retrieveClock(clockId: string): Promise<unknown>;
  retrieveCustomer(customerId: string): Promise<unknown>;
  retrieveSubscription(subscriptionId: string): Promise<unknown>;
}

export type ExactClockObservation = Readonly<{
  version: "exact-clock-observation-v1";
  context: ExactPaymentContext;
  simulationId: string;
  platformAccountId: string;
  clockId: string;
  customerId: string;
  subscriptionId: string;
  billingTimeSeconds: number;
  startedWallTimeMilliseconds: number;
  observedWallTimeMilliseconds: number;
}>;

const issued = new WeakSet<object>();
const failure = () => new Error("Exact clock observation unavailable");
const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

// Read only relevant own data fields. Ignore extra provider data without copying
// it into observations or diagnostics; accessors/prototypes are not evidence.
function fields(value: unknown, names: readonly string[], exact = false): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw failure();
  if (exact && (Reflect.ownKeys(value).length !== names.length ||
    Reflect.ownKeys(value).some(key => typeof key !== "string" || !names.includes(key)))) throw failure();
  const result: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw failure();
    result[name] = descriptor.value;
  }
  return result;
}

function reference(value: unknown): unknown {
  return typeof value === "string" ? value : fields(value, ["id"]).id;
}

function bindingSnapshot(value: unknown): ExactClockBinding {
  const b = fields(value, ["version", "simulationId", "clockId", "customerId", "subscriptionId"], true);
  if (b.version !== "exact-clock-binding-v1" || typeof b.simulationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(b.simulationId)) throw failure();
  for (const [name, prefix] of [["clockId", "clock"], ["customerId", "cus"], ["subscriptionId", "sub"]] as const) {
    if (typeof b[name] !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9]{1,100}$`).test(b[name])) throw failure();
  }
  return Object.freeze({ version: "exact-clock-binding-v1", simulationId: b.simulationId,
    clockId: b.clockId as string, customerId: b.customerId as string, subscriptionId: b.subscriptionId as string });
}

/** Same-process provenance and wall freshness only, NOT collection admission.
 * A future store must atomically pin the context/binding, compare its previous
 * billing time and reject regression/reused sequence before admitting anything.
 * It must recheck freshness there; serialized or copied observations fail here. */
export function assertFreshExactClockObservation(
  value: unknown,
  wallNowMilliseconds: number = Date.now(),
): asserts value is ExactClockObservation {
  try {
    if (!value || typeof value !== "object" || !issued.has(value)) throw failure();
    const o = value as ExactClockObservation;
    if (!positiveInteger(wallNowMilliseconds) || wallNowMilliseconds < o.observedWallTimeMilliseconds ||
      wallNowMilliseconds - o.startedWallTimeMilliseconds > EXACT_CLOCK_OBSERVATION_MAX_AGE_MS) throw failure();
  } catch { throw failure(); }
}

export function createExactClockEvidenceReader(args: {
  context: unknown;
  contextEvidence: unknown;
  binding: unknown;
  provider: ExactClockReadOnlyProvider;
  /** Test composition seam; never replace Date, machine time or SDK auth time. */
  wallNowMilliseconds?: () => number;
}): Readonly<{ observe(): Promise<ExactClockObservation> }> {
  try {
    const context: ExactPaymentContext = validateExactPaymentContext(args.context, args.contextEvidence);
    if (context.mode !== "test") throw failure();
    const binding = bindingSnapshot(args.binding);
    const wallNow = args.wallNowMilliseconds ?? Date.now;
    if (typeof wallNow !== "function") throw failure();
    const provider = args.provider;
    // Pin method references as well as identities before the first asynchronous
    // read, so caller mutation cannot swap the port during an observation.
    const accountRead = provider.observePlatformAccount.bind(provider);
    const clockRead = provider.retrieveClock.bind(provider);
    const customerRead = provider.retrieveCustomer.bind(provider);
    const subscriptionRead = provider.retrieveSubscription.bind(provider);

    async function account(): Promise<string> {
      const a = fields(await accountRead(), ["id"]);
      if (a.id !== context.platformAccountId) throw failure();
      return a.id as string;
    }
    async function clock(): Promise<number> {
      const c = fields(await clockRead(binding.clockId), ["id", "livemode", "status", "frozen_time"]);
      assertStripeObjectMatchesExactContext(context, c);
      if (c.id !== binding.clockId || c.status !== "ready" || !positiveInteger(c.frozen_time)) throw failure();
      return c.frozen_time;
    }
    async function customer(): Promise<string> {
      const c = fields(await customerRead(binding.customerId), ["id", "livemode", "test_clock"]);
      assertStripeObjectMatchesExactContext(context, c);
      if (c.id !== binding.customerId || reference(c.test_clock) !== binding.clockId) throw failure();
      return c.id as string;
    }
    async function subscription(): Promise<string> {
      const s = fields(await subscriptionRead(binding.subscriptionId), ["id", "livemode", "customer", "test_clock"]);
      assertStripeObjectMatchesExactContext(context, s);
      if (s.id !== binding.subscriptionId || reference(s.customer) !== binding.customerId ||
        reference(s.test_clock) !== binding.clockId) throw failure();
      return s.id as string;
    }

    return Object.freeze({ async observe(): Promise<ExactClockObservation> {
      try {
        const started = wallNow();
        if (!positiveInteger(started)) throw failure();
        await account();
        const before = await clock();
        await customer();
        await subscription();
        // Sandwich all ownership reads with the same ready clock/account. This
        // detects observed drift, not an impossible atomic provider snapshot or
        // unobserved change-and-restore; no payment authority is issued here.
        await subscription();
        await customer();
        if (await clock() !== before) throw failure();
        await account();
        const observed = wallNow();
        if (!positiveInteger(observed) || observed < started ||
          observed - started > EXACT_CLOCK_OBSERVATION_MAX_AGE_MS) throw failure();
        const observation: ExactClockObservation = Object.freeze({ version: "exact-clock-observation-v1", context,
          simulationId: binding.simulationId, platformAccountId: context.platformAccountId,
          clockId: binding.clockId, customerId: binding.customerId, subscriptionId: binding.subscriptionId,
          billingTimeSeconds: before, startedWallTimeMilliseconds: started, observedWallTimeMilliseconds: observed });
        issued.add(observation);
        return observation;
      } catch { throw failure(); }
    } });
  } catch { throw failure(); }
}
