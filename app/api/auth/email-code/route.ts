import { emailCodeResponse } from '@/lib/emailCodeServer';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: Request) { return emailCodeResponse(req); }
