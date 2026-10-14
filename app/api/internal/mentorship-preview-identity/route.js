import { readPreviewRuntimeIdentity } from '../../../../release-checks/preview-runtime-identity.mjs';
import config from '../../../../vercel.json';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request) { return readPreviewRuntimeIdentity(request, process.env, Object.keys(config.env).filter(name => /^CREATOR_.*_READY$/.test(name))); }
