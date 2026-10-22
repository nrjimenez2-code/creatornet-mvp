/** Type surface for the existing JavaScript diagnostic route. Runtime source
 * and its guarded, read-only completion implementation remain unchanged. */
export const runtime: "nodejs";
export const dynamic: "force-dynamic";
export const maxDuration: 60;
export function GET(request: Request): Promise<Response>;
