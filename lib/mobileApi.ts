import 'server-only';
import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from './supabaseAdmin';
import { mobileBearer, mobileOrigin, mobilePreflightHeaders } from './mobileApiPolicy';
import { allowRequest, clientKey } from './rateLimit';
import type { User } from '@supabase/supabase-js';
type Handler = (req: NextRequest, user: User | null) => Promise<Response>;
function reply(status: number, error: string) { return Response.json({ error }, { status, headers: { 'Cache-Control': 'private, no-store' } }); }
function cors(response: Response, origin: string) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Vary', [headers.get('Vary'), 'Origin'].filter(Boolean).join(', '));
  headers.set('Cache-Control', 'private, no-store');
  // Native authentication never writes or consumes the website's cookies.
  headers.delete('set-cookie');
  return new Response(response.body, { status: response.status, headers });
}
export function mobileApi(handler: Handler, methods: readonly string[], required = true) {
  return async (incoming: NextRequest): Promise<Response> => {
    if (process.env.CREATORNET_IOS_API_ENABLED !== 'true') return reply(503, 'CreatorNet is temporarily unavailable.');
    const origin = mobileOrigin(incoming.headers.get('origin'), process.env.CREATORNET_IOS_DEV_ORIGIN);
    if (!origin) return reply(403, 'Invalid request origin.');
    if (incoming.method === 'OPTIONS') {
      if (!methods.includes(incoming.headers.get('access-control-request-method') ?? '') || !mobilePreflightHeaders(incoming.headers.get('access-control-request-headers') ?? '')) return cors(reply(403, 'Invalid request.'), origin);
      return cors(new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': methods.join(', '), 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-CN-Discover-Actor', 'Access-Control-Max-Age': '300' } }), origin);
    }
    if (!methods.includes(incoming.method)) return cors(reply(405, 'Method not allowed.'), origin);
    if (!allowRequest(`ios-api:${clientKey(incoming)}`, { limit: 300, windowMs: 60_000 })) return cors(reply(429, 'Please wait before trying again.'), origin);
    const supplied = incoming.headers.get('authorization');
    const token = mobileBearer(supplied);
    if ((required && !token) || (supplied !== null && !token)) return cors(reply(401, 'Sign in required.'), origin);
    try {
      let user: User | null = null;
      if (token) {
        const verifier = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
        const verified = await verifier.auth.getUser(token);
        if (verified.error || !verified.data.user) return cors(reply(401, 'Sign in required.'), origin);
        user = verified.data.user;
        const profile = await supabaseAdmin.from('profiles').select('id,banned_at').eq('id', user.id).maybeSingle();
        if (profile.error) return cors(reply(503, 'Could not verify your account.'), origin);
        if (!profile.data) return cors(reply(401, 'Sign in required.'), origin);
        if (profile.data.banned_at) return cors(reply(403, 'Your account cannot access CreatorNet.'), origin);
      }
      const headers = new Headers(incoming.headers);
      headers.delete('cookie');
      let body: Uint8Array | undefined;
      if (!['GET', 'HEAD'].includes(incoming.method)) {
        if (!incoming.headers.get('content-type')?.startsWith('application/json')) return cors(reply(415, 'Use a JSON request.'), origin);
        const reader = incoming.body?.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        if (reader) for (;;) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.length;
          if (size > 65_536) { await reader.cancel(); return cors(reply(413, 'Request too large.'), origin); }
          chunks.push(next.value);
        }
        body = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
      }
      const request = new NextRequest(incoming.url, { method: incoming.method, headers, body: body as BodyInit | undefined, signal: incoming.signal });
      return cors(await handler(request, user), origin);
    } catch { return cors(reply(503, 'Could not complete this request. Please try again.'), origin); }
  };
}
