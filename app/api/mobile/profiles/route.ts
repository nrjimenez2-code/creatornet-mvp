import { GET as websiteProfiles } from '@/app/api/profiles/route';
import { mobileApi } from '@/lib/mobileApi';
export const dynamic = 'force-dynamic';
const handler = mobileApi(req => websiteProfiles(req), ['GET']);
export const GET = handler;
export const OPTIONS = handler;
