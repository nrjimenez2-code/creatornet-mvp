const STORAGE_KEY = "recent-searches";
const CHANGED_EVENT = "creatornet:recent-searches-changed";

// A string snapshot is stable between writes and safe during server hydration.
export const recentSearchesServerSnapshot = () => "[]";

export function readRecentSearches(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) || "[]";
  } catch {
    return "[]";
  }
}

export function parseRecentSearches(snapshot: string): string[] {
  try {
    const value: unknown = JSON.parse(snapshot);
    return Array.isArray(value)
      ? value.filter((term): term is string => typeof term === "string").slice(0, 10)
      : [];
  } catch {
    return [];
  }
}

export function subscribeRecentSearches(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGED_EVENT, onChange);
  };
}

export function saveRecentSearches(terms: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(terms.slice(0, 10)));
    window.dispatchEvent(new Event(CHANGED_EVENT));
  } catch {
    // Search remains usable when browser storage is unavailable or full.
  }
}
