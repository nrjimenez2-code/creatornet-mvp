import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import FeedList from '@/components/FeedList';
export default function Feed() {
  const [query] = useSearchParams();
  const [tab, setTab] = useState<'following' | 'discover'>(query.get('tab') === 'following' ? 'following' : 'discover');
  return <main className="app-feed"><div className="app-feed-header" aria-label="Feed">
    <button type="button" aria-pressed={tab === 'following'} onClick={() => setTab('following')}>Following</button>
    <button type="button" aria-pressed={tab === 'discover'} onClick={() => setTab('discover')}>Discover</button>
  </div><FeedList activeTab={tab} onChangeTab={setTab} highlightPostId={query.get('postId')} /></main>;
}
