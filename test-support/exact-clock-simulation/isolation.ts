import { PGlite, type Results } from "@electric-sql/pglite";

// Type branding is convenient, but the private identity set is the runtime
// authority. Copying properties, casting a foreign client, or wrapping a real
// handle in a Proxy does not grant this capability.
declare const memoryDatabaseBrand: unique symbol;
export interface ExactClockMemoryDatabase {
  readonly [memoryDatabaseBrand]: true;
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<Results<T>>;
  exec(sql: string): Promise<Results[]>;
  close(): Promise<void>;
}

const activeHandles = new WeakSet<object>();

export function assertExactClockMemoryDatabase(value: unknown): asserts value is ExactClockMemoryDatabase {
  if (typeof value !== "object" || value === null || !activeHandles.has(value)) {
    throw new Error("Exact clock simulation requires its own active in-memory database");
  }
}

/** Zero-configuration, process-local capability factory. No supplied database,
 * URL, directory, environment, credentials, filesystem adapter or extensions.
 * SQL consumers must assert this capability before installing their private
 * cnqa_clock_v1 namespace. This wrapper is not a general SQL sandbox: its
 * guarantee is the identity and in-memory construction of the target backend.
 */
export async function createExactClockMemoryDatabase(): Promise<ExactClockMemoryDatabase> {
  // Reject JS callers attempting options even though TypeScript accepts none.
  if (arguments.length !== 0) throw new Error("Exact clock memory factory accepts no configuration");
  const memory = new PGlite({});
  try {
    await memory.waitReady;
  } catch (error) {
    await memory.close().catch(() => undefined);
    throw error;
  }
  let closing: Promise<void> | undefined;
  const handle = Object.freeze({
    async query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<Results<T>> {
      assertExactClockMemoryDatabase(handle);
      return memory.query<T>(sql, params ? [...params] : undefined);
    },
    async exec(sql: string): Promise<Results[]> {
      assertExactClockMemoryDatabase(handle);
      return memory.exec(sql);
    },
    close(): Promise<void> {
      if (!closing) {
        activeHandles.delete(handle);
        closing = memory.close();
      }
      return closing;
    },
  }) as ExactClockMemoryDatabase;
  activeHandles.add(handle);
  return handle;
}
