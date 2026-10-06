import { mobileApi } from '@/lib/mobileApi';
import { readMobileProfile } from '@/lib/mobileProfileRead';
import type { NextRequest } from 'next/server';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ identifier: string }> };
export async function GET(req: NextRequest, context: Context) {
  const { identifier } = await context.params;
  return mobileApi((request, user) => readMobileProfile(request, identifier, user), ['GET'], identifier === 'me')(req);
}
export const OPTIONS = mobileApi(async () => new Response(null, { status: 204 }), ['GET'], false);
