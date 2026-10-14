export type MentionAccount = {
  id: string;
  username: string;
  full_name: string | null;
  avatar_url: string | null;
};
export type BioMention = { start: number; end: number; username: string };
export type MentionResolution = { accounts: MentionAccount[]; ambiguousNames: string[] };
export const BIO_LIMIT = 600;
export const USERNAME_PATTERN = /^[a-z0-9._]{1,20}$/i;

// A boundary excludes emails and embedded handles. Keep username punctuation.
export function bioMentions(bio: string): BioMention[] {
  const matches: BioMention[] = [];
  for (const match of bio.matchAll(/(^|[^\p{L}\p{N}._@+\-/])@([a-z0-9._]+)/giu)) {
    const username = match[2];
    if (!USERNAME_PATTERN.test(username) || !/[a-z0-9_]/i.test(username)) continue;
    const start = match.index! + match[1].length;
    matches.push({ start, end: start + username.length + 1, username });
  }
  return matches;
}

export function mentionCandidates(username: string): string[] {
  // Prefer the complete canonical handle; a sentence-ending period can follow it.
  const bare = username.replace(/\.+$/, "");
  return bare && bare !== username ? [username.toLowerCase(), bare.toLowerCase()] : [username.toLowerCase()];
}

export function activeBioMention(bio: string, cursor: number): BioMention | null {
  const token = bioMentions(bio).find(m => cursor > m.start + 1 && cursor <= m.end);
  return token ? { ...token, username: bio.slice(token.start + 1, cursor) } : null;
}

export function replaceBioMention(bio: string, token: BioMention, username: string) {
  const text = bio.slice(0, token.start) + "@" + username + bio.slice(token.end);
  return text.length <= BIO_LIMIT ? { text, cursor: token.start + username.length + 1 } : null;
}

export type WebsiteValidation = { url: string | null; error: string | null };
export function validateWebsite(input: string): WebsiteValidation {
  const value = input.trim();
  if (!value) return { url: null, error: null };
  const invalid = { url: null, error: "Enter a valid HTTP or HTTPS website without a username or password." };
  if (value.length > 2048) return { url: null, error: "Website must be 2,048 characters or fewer." };
  if (/[\s\\\u0000-\u001f\u007f]/u.test(value) || value.startsWith("//")) return invalid;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(value);
  // A bare hostname can include a port. All other explicit schemes fail closed.
  const bareWithPort = /^[^/:?#]+:\d+(?:[/?#]|$)/.test(value);
  if (hasScheme && !bareWithPort && !/^https?:\/\//i.test(value)) return invalid;
  try {
    if (/^https?:\/\//i.test(value) && !/^https?:\/\/[^/?#]+/i.test(value)) return invalid;
    const url = new URL(hasScheme && !bareWithPort ? value : `https://${value}`);
    const authority = (hasScheme && !bareWithPort ? value : `https://${value}`).split("//")[1]?.split(/[/?#]/)[0];
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !url.hostname ||
      (!url.hostname.includes(".") && url.hostname !== "localhost" && !url.hostname.startsWith("["))) return invalid;
    if (authority?.includes("@")) return invalid;
    if (!url.hostname.startsWith("[") && url.hostname.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return invalid;
    if (url.href.length > 2048) return { url: null, error: "Website must be 2,048 characters or fewer." };
    return { url: url.href, error: null };
  } catch { return invalid; }
}

export function websiteLabel(url: string) {
  const parsed = new URL(url);
  return parsed.host + (parsed.pathname === "/" ? "" : parsed.pathname);
}
