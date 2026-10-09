import { GET as websiteTag } from '@/app/api/tag/[hashtag]/route';
import { mobileApi } from '@/lib/mobileApi';
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ hashtag: string }> };
const handler = (req: NextRequest, context: Context) =>
  mobileApi(inner => websiteTag(inner, context), ['GET'], false)(req);
export const GET = handler;
export const OPTIONS = handler;
