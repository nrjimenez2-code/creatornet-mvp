/**
 * A recording stand-in for a supabase-js client.
 *
 * The existing suite never imports a route handler — every "route" test reads
 * the route's source as text and regexes it, which passes whether or not the
 * code works. Driving a handler for real needs a client that behaves like
 * PostgREST's builder: chainable, thenable, and terminal on
 * .single()/.maybeSingle()/await.
 *
 * Every operation is recorded so a test can assert on what the handler actually
 * asked the database to do — which table, which filters, which payload.
 */

export type Op = {
  table: string;
  kind: "select" | "insert" | "update" | "delete" | "rpc";
  /** .eq()/.match() filters, flattened to column -> value. */
  filters: Record<string, unknown>;
  /** .not(col, op, value) calls, in order. */
  notFilters: Array<{ column: string; op: string; value: string }>;
  /** .in(col, values) calls. */
  inFilters: Array<{ column: string; values: unknown[] }>;
  /** .is(col, value) calls, in order (also mirrored into `filters`). */
  isFilters: Array<{ column: string; value: unknown }>;
  /** .or(filterString) calls, in order. */
  orFilters: string[];
  /** Payload passed to .insert()/.update()/.rpc(). */
  payload?: unknown;
  /** Columns passed to .select(). */
  columns?: string;
};

export type Responder = (op: Op) => { data: unknown; error: unknown } | undefined;

export type MockClient = {
  from: (table: string) => any;
  rpc: (name: string, args: unknown) => any;
  storage: { from: (b: string) => any };
  auth: { getUser: (t?: string) => Promise<any> };
  /** Every operation that reached a terminal, in order. */
  ops: Op[];
  /** Operations against one table. */
  opsFor: (table: string) => Op[];
};

const DEFAULT: { data: unknown; error: unknown } = { data: null, error: null };

/**
 * @param respond called for each terminal operation; return undefined to fall
 *   through to `{ data: null, error: null }`.
 */
export function createMockClient(respond: Responder = () => undefined): MockClient {
  const ops: Op[] = [];

  function builder(table: string, kind: Op["kind"], payload?: unknown) {
    const op: Op = { table, kind, filters: {}, notFilters: [], inFilters: [], isFilters: [], orFilters: [], payload };
    let settled = false;

    const resolve = () => {
      if (!settled) {
        ops.push(op);
        settled = true;
      }
      return respond(op) ?? DEFAULT;
    };

    const chain: any = {
      select(columns?: string) {
        op.columns = columns;
        if (kind === "select") return chain;
        return chain;
      },
      eq(column: string, value: unknown) {
        op.filters[column] = value;
        return chain;
      },
      is(column: string, value: unknown) {
        op.filters[column] = value;
        op.isFilters.push({ column, value });
        return chain;
      },
      contains(column: string, value: unknown) {
        op.filters[column] = value;
        return chain;
      },
      match(obj: Record<string, unknown>) {
        Object.assign(op.filters, obj);
        return chain;
      },
      or(filters?: string) {
        if (typeof filters === "string") op.orFilters.push(filters);
        return chain;
      },
      ilike(column: string, value: unknown) {
        op.filters[column] = value;
        return chain;
      },
      in(column: string, values: unknown[]) {
        op.inFilters.push({ column, values });
        return chain;
      },
      not(column: string, o: string, value: string) {
        op.notFilters.push({ column, op: o, value });
        return chain;
      },
      order() {
        return chain;
      },
      limit() {
        return chain;
      },
      returns() {
        return chain;
      },
      single() {
        return Promise.resolve(resolve());
      },
      maybeSingle() {
        return Promise.resolve(resolve());
      },
      then(onOk: any, onErr: any) {
        return Promise.resolve(resolve()).then(onOk, onErr);
      },
    };
    return chain;
  }

  const client: MockClient = {
    ops,
    opsFor: (table: string) => ops.filter((o) => o.table === table),
    from: (table: string) => ({
      select: (columns?: string) => builder(table, "select").select(columns),
      insert: (payload: unknown) => builder(table, "insert", payload),
      update: (payload: unknown) => builder(table, "update", payload),
      delete: () => builder(table, "delete"),
    }),
    rpc: (name: string, args: unknown) => builder(name, "rpc", args),
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/file" }, error: null }),
      }),
    },
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  };

  return client;
}
