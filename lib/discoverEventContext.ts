import 'server-only';
import {supabaseAdmin as admin} from './supabaseAdmin';
import {DISCOVER_EVENT_POST_COLUMNS, type DiscoverEventPost, type DiscoverEventOffers} from './discoverServer';

type EventContext = {
  post: DiscoverEventPost & {video_url?: string};
  audience: string;
  offers?: DiscoverEventOffers;
};

export async function loadDiscoverEventContext(sessionId:string, actor:string, postId:string):Promise<EventContext|null> {
  if (process.env.DISCOVER_EVENT_CONTEXT_ENABLED === 'true') {
    const {data,error} = await admin.rpc('discover_event_context_v1', {
      p_session:sessionId,p_actor:actor,p_post:postId,
    });
    if (error) throw error;
    if (data === null) return null;
    if (!data?.post || data.post.id !== postId || !data.post.creator_id ||
        typeof data.audience !== 'string' ||
        !['primaryProducts','legacyProducts','offerings'].every(key=>Array.isArray(data[key]))) {
      throw new Error('Invalid event context');
    }
    return {post:data.post,audience:data.audience,offers:{
      primaryProducts:data.primaryProducts,legacyProducts:data.legacyProducts,offerings:data.offerings,
    }};
  }
  const {data:session,error} = await admin.from('discover_sessions_v1')
    .select('post_ids,expires_at,audiences').eq('id',sessionId).eq('actor',actor).single();
  if (error || !session || Date.parse(session.expires_at)<=Date.now() || !session.post_ids.includes(postId)) return null;
  const {data:post,error:postError} = await admin.from('posts')
    .select(`${DISCOVER_EVENT_POST_COLUMNS},active,hidden_at,removed_at,video_url` as const).eq('id',postId).single();
  if (postError || !post || post.active===false || post.hidden_at || post.removed_at) return null;
  const {data:creator,error:creatorError} = await admin.from('profiles').select('banned_at').eq('id',post.creator_id).single();
  if (creatorError || !creator || creator.banned_at) return null;
  return {post,audience:session.audiences?.[postId] ?? 'general'};
}
