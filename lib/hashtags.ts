// lib/hashtags.ts
export function extractHashtags(text: string | null | undefined): string[] {
    if (!text) return [];
    const set = new Set<string>();
    const regex = /#([a-z0-9_]+)/gi;
    let m;
  
    while ((m = regex.exec(text))) {
      set.add(m[1].toLowerCase());
    }
  
    return Array.from(set);
  }
  