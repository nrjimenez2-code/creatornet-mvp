import { GET as websiteOffers } from '@/app/api/posts/feed-offers/route';
import { mobileApi } from '@/lib/mobileApi';
export const dynamic = 'force-dynamic';
const handler = mobileApi(req => websiteOffers(req), ['GET'], false);
export const GET = handler;
export const OPTIONS = handler;
