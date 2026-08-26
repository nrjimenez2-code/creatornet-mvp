// lib/ids.ts — guard for ids that get interpolated into PostgREST filters.
//
// `.or("product_id.eq.X,id.eq.X")` builds a filter string. If X contains
// `,`, `)` or `.` an attacker can change the filter's meaning. Our ids are
// uuids or simple slugs, so anything outside [A-Za-z0-9_-] is rejected
// before it reaches the query.

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

/** PostgREST `or` filter matching either column to a safe id. Throws on unsafe input. */
export function eitherIdFilter(columns: [string, string], id: string): string {
  if (!isSafeId(id)) throw new Error("Invalid id");
  return `${columns[0]}.eq.${id},${columns[1]}.eq.${id}`;
}
