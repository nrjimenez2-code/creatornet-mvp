"use client";
import { useEffect, useRef, useState } from "react";
import { EMPTY_SEARCH, type SearchResponse } from "@/lib/searchTypes";
import { trackEvent } from "@/lib/posthog";

export function useSearchResults(query: string) {
  const term = query.trim();
  const [state, setState] = useState({ term: "", result: EMPTY_SEARCH, loading: false, error: "" });
  const [page, setPage] = useState({ term, value: 0 });
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const previousSearch = useRef<string | null>(null);
  const pageNumber = page.term === term ? page.value : 0;
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    if (!term) {
      setState({ term: "", result: EMPTY_SEARCH, loading: false, error: "" });
      return () => controller.abort();
    }
    setState(old => ({ term, result: pageNumber > 0 && old.term === term ? old.result : EMPTY_SEARCH, loading: true, error: "" }));
    const timer = setTimeout(async () => {
      const started = performance.now();
      try {
        const response = await fetch("/api/search/perform", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: term, page: pageNumber }), signal: controller.signal,
        });
        if (!response.ok) throw new Error("Search isn't working right now. Please try again.");
        const data = await response.json() as SearchResponse;
        if (!Array.isArray(data.creators) || !Array.isArray(data.items) || !Array.isArray(data.offerings) || !data.totals) throw new Error("Search returned an incomplete response. Please try again.");
        if (controller.signal.aborted || current !== generation.current) return;
        setState(old => ({ term, loading: false, error: "", result: pageNumber > 0 && old.term === term ? {
          ...data,
          creators: unique([...old.result.creators,...data.creators]),
          items: unique([...old.result.items,...data.items]),
          offerings: unique([...old.result.offerings,...data.offerings]),
        } : data }));
        const count = data.totals.creators + data.totals.videos + data.totals.offerings;
        trackEvent("search_performed", { query: term, results_count: count, page: pageNumber, latency_ms: Math.round(performance.now()-started), search_version: 1 });
        if (pageNumber === 0) {
          if (count === 0) trackEvent("search_no_results", { query: term });
          if (previousSearch.current && previousSearch.current !== term) trackEvent("search_reformulated", { previous_query: previousSearch.current, query: term });
          previousSearch.current = term;
        }
      } catch (error) {
        if (controller.signal.aborted || current !== generation.current) return;
        setState(old => ({ ...old, term, loading: false, error: error instanceof Error ? error.message : "Search failed. Please try again." }));
      }
    }, pageNumber > 0 ? 0 : 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [term, pageNumber, retry]);
  const result = state.term === term ? state.result : EMPTY_SEARCH;
  return {
    result, loading: !!term && (state.term !== term || state.loading), error: state.term === term ? state.error : "",
    loadMore: () => setPage({ term, value: pageNumber + 1 }), retry: () => setRetry(value => value + 1),
    hasMore: result.creators.length < result.totals.creators || result.items.length < result.totals.videos || result.offerings.length < result.totals.offerings,
  };
}
function unique<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map(item => [item.id,item])).values()];
}
