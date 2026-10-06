import { POST as websiteEvents } from '@/app/api/feed-events/route';
import { mobileApi } from '@/lib/mobileApi';
export const dynamic = 'force-dynamic';
const handler = mobileApi(req => websiteEvents(req), ['POST'], false);
export const POST = handler;
export const OPTIONS = handler;
