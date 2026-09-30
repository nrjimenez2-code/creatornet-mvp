import Link from "next/link";
import { bioMentions, mentionCandidates, validateWebsite, websiteLabel, type MentionAccount } from "@/lib/profileBio";
import styles from "./profile-bio.module.css";

export default function ProfileBio({ bio, emptyMessage, websiteUrl, accounts }: {
  bio: string | null; emptyMessage: string; websiteUrl?: string | null; accounts: MentionAccount[];
}) {
  const text = bio || emptyMessage;
  const byName = new Map(accounts.map(account => [account.username.toLowerCase(), account]));
  const parts: React.ReactNode[] = [];
  let position = 0;
  for (const token of bioMentions(text)) {
    parts.push(text.slice(position, token.start));
    const name = mentionCandidates(token.username).find(candidate => byName.has(candidate));
    const account = name ? byName.get(name) : undefined;
    if (account && name) {
      const end = token.start + name.length + 1;
      parts.push(<Link key={token.start} href={`/creators/${account.id}`} className={styles.link}>{text.slice(token.start, end)}</Link>);
      parts.push(text.slice(end, token.end));
    } else parts.push(text.slice(token.start, token.end));
    position = token.end;
  }
  parts.push(text.slice(position));
  const website = validateWebsite(websiteUrl ?? "").url;
  return <div className={styles.bio}>
    <p className={styles.text}>{parts}</p>
    {website ? <a className={`${styles.website} ${styles.link}`} href={website} target="_blank" rel="noopener noreferrer">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
      <span>{websiteLabel(website)}</span>
    </a> : null}
  </div>;
}
