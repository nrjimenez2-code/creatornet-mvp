import { GET as websiteFeed } from '@/app/api/feed/route';
import { mobileApi } from '@/lib/mobileApi';
export const dynamic = 'force-dynamic';
const handler = mobileApi(req => websiteFeed(req), ['GET'], false);
export const GET = handler;
export const OPTIONS = handler;
