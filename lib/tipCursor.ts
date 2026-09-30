import "server-only";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TipCursor = { at: string; id: string };

export function encodeTipCursor(row: { id: string; created_at?: string; updated_at?: string }): string {
  return Buffer.from(JSON.stringify({ at: row.updated_at ?? row.created_at, id: row.id })).toString("base64url");
}

export function decodeTipCursor(raw: unknown): TipCursor | null {
  if (typeof raw !== "string" || raw.length > 256) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<TipCursor>;
    if (typeof value.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.at) ||
        Number.isNaN(Date.parse(value.at)) || typeof value.id !== "string" || !UUID.test(value.id)) return null;
    return { at: value.at, id: value.id };
  } catch { return null; }
}
