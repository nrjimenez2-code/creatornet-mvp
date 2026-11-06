import completion from '../../../../release-checks/original-monthly-completion.cjs';
import config from '../../../../vercel.json';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request) {
  return completion.readRuntimeIdentity(request, process.env,
    Object.keys(config.env).filter(name => /^CREATOR_[A-Z_]+_READY$/.test(name)));
}
