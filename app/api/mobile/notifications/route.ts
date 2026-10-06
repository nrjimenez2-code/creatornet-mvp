import { GET as websiteNotifications } from '@/app/api/notifications/route';
import { mobileApi } from '@/lib/mobileApi';
export const dynamic = 'force-dynamic';
const handler = mobileApi(req => websiteNotifications(req), ['GET']);
export const GET = handler;
export const OPTIONS = handler;
