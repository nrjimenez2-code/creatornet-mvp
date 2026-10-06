import { useEffect, useState, type ComponentProps } from 'react';
import { Link, useNavigate, useParams, useLocation } from 'react-router-dom';
import ProfileContent from '@/components/ProfileContent';
import ProfileBio from '@/components/ProfileBio';
import FollowButton from '@/components/FollowButton';
import FollowStats from '@/components/FollowStats';
import VerifiedCreatorBadge from '@/components/VerifiedCreatorBadge';
import ProfileMobileHeader from '@/components/ProfileMobileHeader';
import ProfileShareButton from '@/components/ProfileShareButton';
import BackButton from '@/components/BackButton';
import profileNameStyles from '@/components/profile-name.module.css';
import { useUser } from '@/lib/useUser';
import { appApi } from '../platform/api';
import { DEFAULT_AVATAR_URL } from '@/lib/utils';
import { logout } from '../platform/auth';
import { readAppConfig } from '../config';
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
  const { userId } = useUser(); const navigate = useNavigate();
  const [data, setData] = useState<ProfileData | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void appApi.json<ProfileData>('/api/mobile/profile/' + encodeURIComponent(identifier), { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setData(result); }).catch(() => { if (!controller.signal.aborted) setError('Could not load this profile. Please try again.'); });
    return () => controller.abort();
  }, [identifier]);
  if (error) return <main className="app-page"><p role="alert">{error}</p><button type="button" className="app-action" onClick={retry}>Try again</button></main>;
  if (!data) return <main className="app-page" aria-busy="true">Loading profile…</main>;
  const { profile } = data; const name = profile.fullName || profile.username || 'Creator';
  const shareUrl = readAppConfig().websiteOrigin + '/creators/' + encodeURIComponent(profile.id);
  const username = profile.username || 'creator';
  return <section className="px-4 pb-[calc(var(--mobile-tab-bar-height)+1.5rem)] pt-4 md:pt-10 text-white relative"><div className="max-w-6xl mx-auto">
    {data.viewerIsOwner ? <div className="lg:hidden mb-6"><ProfileMobileHeader userId={profile.id} shareUrl={shareUrl} onSignOut={logout} onSignedOut={() => navigate('/auth', { replace: true })} /></div> :
      <div className="flex md:hidden items-center justify-between mb-6"><BackButton hrefOverride="/dashboard" /><div className="flex items-center gap-2">
        <Link to={`/creators/${profile.id}/reviews`} className="inline-flex items-center justify-center rounded-md border border-white/20 px-3 py-1 text-xs font-semibold leading-none text-white hover:bg-white/10 transition">Review</Link><ProfileShareButton shareUrl={shareUrl} />
      </div></div>}
    <div className="flex flex-col items-center text-center mt-0 md:mt-8">
      <div className="h-32 w-32 sm:h-40 sm:w-40 md:h-48 md:w-48 rounded-full bg-white/10 overflow-hidden border border-white/20"><img src={profile.avatarUrl || DEFAULT_AVATAR_URL} alt={`${username} avatar`} className="avatar-image h-full w-full object-cover" /></div>
      <h1 className={`mt-4 sm:mt-6 text-2xl sm:text-3xl font-semibold ${profileNameStyles.heading}${profile.verified ? ` ${profileNameStyles.verified}` : ''}`}><span className={profileNameStyles.name}>{name}</span><VerifiedCreatorBadge verified={profile.verified} className={profileNameStyles.badge} /></h1>
      <p className="text-white/70 text-sm sm:text-base">@{username}</p>
      {!data.viewerIsOwner && profile.tagline && <p className="mt-2 text-sm text-white/60">{profile.tagline}</p>}
      <ProfileBio bio={profile.bio} websiteUrl={profile.websiteUrl} emptyMessage={data.viewerIsOwner ? 'Tell people about yourself.' : 'No bio yet.'} accounts={data.mentions.accounts} ambiguousNames={data.mentions.ambiguousNames} />
      <FollowStats userId={profile.id} postsCount={data.posts.length} followersCount={data.followersCount} followingCount={data.followingCount} />
      {!data.viewerIsOwner && userId && <div className="mt-4 flex flex-wrap items-center justify-center gap-2"><FollowButton creatorId={profile.id} initialFollowing={false} /></div>}
    </div><div className={data.viewerIsOwner ? '' : 'md:pt-8'}>
    <ProfileContent gallery={{ posts: data.posts, creatorId: profile.id, creatorName: name, creatorUsername: profile.username, creatorAvatarUrl: profile.avatarUrl, creatorVerified: profile.verified, likedPostIds: data.likedPostIds, viewerIsOwner: data.viewerIsOwner, tippingAvailable: data.tippingAvailable }}
      offers={{ creatorId: profile.id, creatorName: name, offers: data.offers, sellReady: profile.verified, rating: null }} />
    </div></div></section>;
}
