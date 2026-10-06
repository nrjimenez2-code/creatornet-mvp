import { useEffect, useState, type ComponentProps } from 'react';
import { Link, useNavigate, useParams, useLocation } from 'react-router-dom';
import ProfileContent from '@/components/ProfileContent';
import ProfileBio from '@/components/ProfileBio';
import FollowButton from '@/components/FollowButton';
import FollowStats from '@/components/FollowStats';
import VerifiedCreatorBadge from '@/components/VerifiedCreatorBadge';
import { useUser } from '@/lib/useUser';
import { appApi } from '../platform/api';
import { DEFAULT_AVATAR_URL } from '@/lib/utils';
type ProfileData = {
  profile: { id: string; username: string | null; fullName: string | null; tagline: string | null; avatarUrl: string | null; bio: string | null; websiteUrl: string | null; verified: boolean };
  posts: ComponentProps<typeof ProfileContent>['gallery']['posts']; offers: ComponentProps<typeof ProfileContent>['offers']['offers'];
  likedPostIds: string[]; mentions: { accounts: ComponentProps<typeof ProfileBio>['accounts']; ambiguousNames?: string[] };
  followersCount: number; followingCount: number; viewerIsOwner: boolean; tippingAvailable: boolean;
};
export default function Profile() {
  const { creatorId } = useParams(); const { userId, loading } = useUser(); const navigate = useNavigate(); const location = useLocation();
  const [revision, setRevision] = useState(0);
  useEffect(() => { const refresh = () => setRevision(value => value + 1); window.addEventListener('creatornet:refresh', refresh); return () => window.removeEventListener('creatornet:refresh', refresh); }, []);
  useEffect(() => {
    if (!loading && !creatorId && !userId) navigate('/auth', { replace: true });
  }, [creatorId, userId, loading, navigate]);
  if (loading || (!creatorId && !userId)) return <main className="app-page" aria-busy="true">Loading profile…</main>;
  return <ProfileView key={`${creatorId ?? 'me'}:${userId ?? 'anonymous'}:${location.key}:${revision}`} identifier={creatorId ?? 'me'} retry={() => setRevision(value => value + 1)} />;
}
function ProfileView({ identifier, retry }: { identifier: string; retry: () => void }) {
  const [data, setData] = useState<ProfileData | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void appApi.json<ProfileData>('/api/mobile/profile/' + encodeURIComponent(identifier), { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setData(result); }).catch(() => { if (!controller.signal.aborted) setError('Could not load this profile. Please try again.'); });
    return () => controller.abort();
  }, [identifier]);
  if (error) return <main className="app-page"><p role="alert">{error}</p><button type="button" className="app-action" onClick={retry}>Try again</button></main>;
  if (!data) return <main className="app-page" aria-busy="true">Loading profile…</main>;
  const { profile } = data; const name = profile.fullName || profile.username || 'Creator';
  return <main className="app-page"><img className="app-profile-avatar" src={profile.avatarUrl || DEFAULT_AVATAR_URL} alt="" /><h1>{name}</h1>
    {profile.username && <p>@{profile.username}</p>}<VerifiedCreatorBadge verified={profile.verified} />
    {profile.tagline && <p>{profile.tagline}</p>}
    <ProfileBio bio={profile.bio} websiteUrl={profile.websiteUrl} emptyMessage="" accounts={data.mentions.accounts} ambiguousNames={data.mentions.ambiguousNames} />
    <FollowStats userId={profile.id} postsCount={data.posts.length} followersCount={data.followersCount} followingCount={data.followingCount} />
    {data.viewerIsOwner ? <Link className="app-action" to="/profile/edit">Edit profile</Link> : <FollowButton creatorId={profile.id} initialFollowing={false} />}
    <ProfileContent gallery={{ posts: data.posts, creatorId: profile.id, creatorName: name, creatorUsername: profile.username, creatorAvatarUrl: profile.avatarUrl, creatorVerified: profile.verified, likedPostIds: data.likedPostIds, viewerIsOwner: data.viewerIsOwner, tippingAvailable: data.tippingAvailable }}
      offers={{ creatorId: profile.id, creatorName: name, offers: data.offers, sellReady: profile.verified, rating: null }} />
  </main>;
}
