import NotificationInbox from '@/components/NotificationInbox';
import { useUser } from '@/lib/useUser';
import { Link } from 'react-router-dom';
export default function Notifications() {
  const { userId, loading } = useUser();
  return <main className="app-page"><h1>Notifications</h1>{loading ? <p>Loading…</p> : userId ? <NotificationInbox /> : <Link to="/auth" className="app-action">Sign in</Link>}</main>;
}
