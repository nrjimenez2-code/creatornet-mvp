"use client";
import { useEffect, useState } from "react";

export default function SearchSuggestions({ query, onPick }: { query: string; onPick: (term: string) => void }) {
  const [state,setState] = useState<{ query: string; suggestions: Array<{label:string;type:string}> }>({query:"",suggestions:[]});
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search/suggest?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json();
        if (!controller.signal.aborted && Array.isArray(data.suggestions)) setState({ query, suggestions: data.suggestions });
      } catch { /* Suggestions must not prevent submitting a search. */ }
    },250);
    return () => { clearTimeout(timer); controller.abort(); };
  },[query]);
  const suggestions = state.query === query ? state.suggestions : [];
  if (!suggestions.length) return null;
  return <section aria-label={query.trim() ? "Search suggestions" : "Topics in recent posts"} className="py-3">
    {!query.trim() && <h2 className="text-sm text-white/60 mb-2">Topics in recent posts</h2>}
    <div className="flex gap-2 overflow-x-auto no-scrollbar py-1">
      {suggestions.map((item,index) => <button key={`${item.type}:${item.label}:${index}`} type="button" onClick={()=>onPick(item.label)}
        title={item.label} className="shrink-0 max-w-64 truncate rounded-full border border-white/15 px-3 py-2 text-sm text-white/80 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-purple-500">
        {item.type === "creator" ? `@${item.label}` : item.label}
        {query.trim() && <span className="ml-2 text-xs text-white/40">{item.type}</span>}
      </button>)}
    </div>
  </section>;
}
