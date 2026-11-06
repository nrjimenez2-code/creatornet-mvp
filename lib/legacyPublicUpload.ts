import 'server-only';
import { abuseHash } from './abuse/admission';
import { supabaseAdmin } from './supabaseAdmin';

/** Exact retained reservation lookup. Never admits, debits, signs or writes. */
export async function hasLegacyPublicUploadReservation(input: {
  ownerId: string; operationId: string; folder: 'videos' | 'thumbnails';
  extension: string; size: number; contentType: string; key: string;
}): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc('find_legacy_public_upload_reservation_v1', {
    p_actor: abuseHash('actor', 'user:' + input.ownerId),
    p_operation: abuseHash('operation', 'public:' + input.ownerId + ':' + input.operationId),
    p_contract: abuseHash('contract', JSON.stringify({
      folder: input.folder, ext: input.extension, size: input.size, mime: input.contentType,
    })),
    p_resource: input.key,
  }).abortSignal(AbortSignal.timeout(5000));
  if (error) throw new Error('legacy_upload_reservation_unavailable');
  return data?.resource === input.key;
}
