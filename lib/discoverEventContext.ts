import 'server-only';
import {supabaseAdmin as admin} from './supabaseAdmin';
import {DISCOVER_EVENT_POST_COLUMNS, type DiscoverEventIdentity, type DiscoverEventPost, type DiscoverEventOffers} from './discoverServer';

type EventContext = {
  actor: string;
  userId: string | null;
  post: DiscoverEventPost & {video_url?: string};
  audience: string;
  offers?: DiscoverEventOffers;
  watched?: number;
  recordedKinds?: string[];
};

export async function loadDiscoverEventContext(sessionId:string, identity:DiscoverEventIdentity, postId:string, claimedSeconds?:number):Promise<EventContext|null> {
  const {actorCandidate:actor,userId}=identity;
  if (process.env.DISCOVER_EVENT_CONTEXT_ENABLED === 'true') {
    const withWatch = claimedSeconds !== undefined;
    const {data,error} = await admin.rpc(withWatch ? 'discover_watch_context_v1' : 'discover_event_context_v1', {
      p_session:sessionId,p_actor:actor,p_post:postId,
      ...(withWatch ? {p_claimed:claimedSeconds} : {}),
    });
    // The former direct table lookup also denied malformed UUIDs as invalid exposure.
    if (error?.code === '22P02') return null;
    if (error) throw error;
    if (data === null) return null;
    // Fail closed if the application was deployed before the identity-check
    // migration: an older context response is not authority for a candidate.
    if (identity.anonymousClaimCheck === 'context' && data?.anonymousClaimChecked !== true)
      throw new Error('Event identity check unavailable');
    if (data.recordedKinds !== undefined && (!Array.isArray(data.recordedKinds) ||
        !data.recordedKinds.every((kind:unknown)=>['exposure','qualified_view','completion'].includes(kind as string))))
      throw new Error('Invalid watch receipts');
    if (!data?.post || data.post.id !== postId || !data.post.creator_id ||
        typeof data.audience !== 'string' || (withWatch &&
          (typeof data.watched !== 'number' || !Number.isFinite(data.watched) || data.watched < 0)) ||
        !['primaryProducts','legacyProducts','offerings'].every(key=>Array.isArray(data[key]))) {
      throw new Error('Invalid event context');
    }
    return {actor,userId,post:data.post,audience:data.audience,...(withWatch ? {watched:data.watched,recordedKinds:data.recordedKinds} : {}),offers:{
      primaryProducts:data.primaryProducts,legacyProducts:data.legacyProducts,offerings:data.offerings,
    }};
  }
  // A candidate issued for the private RPC must never fall through to the
  // legacy path, which assumes discoverIdentity already checked claim status.
  if (identity.anonymousClaimCheck !== 'complete') throw new Error('Event identity check unavailable');
  const {data:session,error} = await admin.from('discover_sessions_v1')
    .select('post_ids,expires_at,audiences').eq('id',sessionId).eq('actor',actor).single();
  if (error || !session || Date.parse(session.expires_at)<=Date.now() || !session.post_ids.includes(postId)) return null;
  const {data:post,error:postError} = await admin.from('posts')
    .select(`${DISCOVER_EVENT_POST_COLUMNS},active,hidden_at,removed_at,video_url` as const).eq('id',postId).single();
  if (postError || !post || post.active===false || post.hidden_at || post.removed_at) return null;
  const {data:creator,error:creatorError} = await admin.from('profiles').select('banned_at').eq('id',post.creator_id).single();
  if (creatorError || !creator || creator.banned_at) return null;
  return {actor,userId,post,audience:session.audiences?.[postId] ?? 'general'};
}
