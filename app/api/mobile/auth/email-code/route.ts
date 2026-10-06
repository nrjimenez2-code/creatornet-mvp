import { emailCodeResponse } from '@/lib/emailCodeServer';
import { mobileApi } from '@/lib/mobileApi';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const handler = mobileApi(req => emailCodeResponse(req, req.headers.get('origin')!), ['POST'], false);
export const POST = handler;
export const OPTIONS = handler;
