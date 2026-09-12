"use client";
import { Suspense, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import BackButton from "@/components/BackButton";
import SearchSuggestions from "@/components/SearchSuggestions";
import { DEFAULT_AVATAR_URL } from "@/lib/utils";
import { trackEvent } from "@/lib/posthog";
import { useSearchResults } from "@/lib/useSearchResults";
import { readRecentSearches, subscribeRecentSearches, recentSearchesServerSnapshot, parseRecentSearches, saveRecentSearches } from "@/lib/recentSearches";
import type { SearchCreator, SearchPost, SearchOffering } from "@/lib/searchTypes";

type Tab = "all" | "creators" | "videos" | "offerings";
function SearchPage() {
  const params = useSearchParams();
  const router = useRouter();
  const urlQuery = params.get("q") ?? "";
  const [draft,setDraft] = useState({urlQuery,value:urlQuery});
  const query = draft.urlQuery === urlQuery ? draft.value : urlQuery;
  const setQuery = (value: string) => setDraft({urlQuery,value});
  const [tab,setTab] = useState<Tab>("all");
  const search = useSearchResults(query);
  const recentSnapshot = useSyncExternalStore(subscribeRecentSearches, readRecentSearches, recentSearchesServerSnapshot);
  const recent = useMemo(()=>parseRecentSearches(recentSnapshot),[recentSnapshot]);
  const pick = (term: string) => {
    setQuery(term);
    const value=term.trim();
    if(value) saveRecentSearches([value,...recent.filter(r=>r.toLowerCase()!==value.toLowerCase())].slice(0,10));
    router.replace(value ? `/search?q=${encodeURIComponent(value)}` : "/search", {scroll:false});
  };
  const {creators,items,offerings,totals}=search.result;
  const count=totals.creators+totals.videos+totals.offerings;
  const openResult=(type:string,id:string,position:number)=>trackEvent("search_result_opened",{query:query.trim(),result_type:type,result_id:id,position,tab,search_version:1});
  useEffect(()=>{
    if (!query.trim() || search.loading || search.error) return;
    trackEvent("search_results_viewed",{query:query.trim(),tab,creator_ids:creators.map(c=>c.id),post_ids:items.map(p=>p.id),offering_ids:offerings.map(o=>o.id)});
  },[query,tab,creators,items,offerings,search.loading,search.error]);
  return <main className="min-h-screen bg-black text-white">
    <div className="sticky top-0 z-30 bg-black border-b border-white/10">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
        <BackButton hrefOverride="/dashboard" />
        <form className="flex flex-1 gap-2 min-w-0" onSubmit={e=>{e.preventDefault();pick(query);}}>
          <input aria-label="Search CreatorNet" value={query} maxLength={160} onChange={e=>setQuery(e.target.value)} placeholder="Search creators, topics, or services" inputMode="search"
            className="min-w-0 flex-1 rounded-full border border-white/20 px-4 py-3 bg-black outline-none focus:ring-2 focus:ring-[#4A35C7]" />
          {!!query && <button type="button" aria-label="Clear search" onClick={()=>pick("")} className="px-2 text-white/60">✕</button>}
          <button className="rounded-full bg-[#4A35C7] px-4 py-2 font-medium" type="submit">Search</button>
        </form>
      </div>
    </div>
    <div className="max-w-6xl mx-auto px-4 py-5">
      <SearchSuggestions query={query} onPick={pick}/>
      {!query.trim() ? <section className="mt-6"><h2 className="text-lg mb-3">Recent searches</h2>
        <div className="flex flex-wrap gap-2">{recent.map(term=><button key={term} onClick={()=>pick(term)} className="border border-white/15 rounded-full px-3 py-2">{term}</button>)}</div>
        {!recent.length && <p className="text-white/50 text-sm">Search for a creator, something you want to learn, or a service you need.</p>}
      </section> : <>
        <div role="tablist" aria-label="Search result types" className="flex gap-5 border-b border-white/15 mb-5 overflow-x-auto">
          {(["all","creators","videos","offerings"] as Tab[]).map(value=><button key={value} role="tab" aria-selected={tab===value} onClick={()=>setTab(value)}
            className={`py-3 border-b-2 capitalize ${tab===value ? "border-[#7059ef] text-white" : "border-transparent text-white/50"}`}>{value}{value!=="all" && !search.loading ? ` (${totals[value]})` : ""}</button>)}
        </div>
        {search.loading && <p role="status" className="text-sm text-white/60 py-3">Searching…</p>}
        {search.error && <div role="alert" className="border border-red-400/30 rounded-xl p-4"><p>{search.error}</p><button onClick={search.retry} className="mt-2 underline">Try again</button></div>}
        {!search.loading && !search.error && count===0 && <p className="py-8 text-white/60">No matches for “{query.trim()}”. Try a broader topic or another spelling.</p>}
        {!search.error && count>0 && <div role="tabpanel" className="space-y-8">
          {(tab==="all" || tab==="creators") && <section><h2 className="text-lg mb-3">Creators</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">{creators.map((creator,index)=><CreatorCard key={creator.id} creator={creator} onOpen={()=>openResult("creator",creator.id,index+1)}/>)}</div>
            {!creators.length && <p className="text-white/50 text-sm">No matching creators.</p>}
          </section>}
          {(tab==="all" || tab==="videos") && <section><h2 className="text-lg mb-3">Videos</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">{items.map((post,index)=><PostCard key={post.id} post={post} onOpen={()=>openResult("video",post.id,index+1)}/>)}</div>
            {!items.length && <p className="text-white/50 text-sm">No matching videos.</p>}
          </section>}
          {(tab==="all" || tab==="offerings") && <section><h2 className="text-lg mb-3">Offerings</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">{offerings.map((offering,index)=><OfferingCard key={offering.id} offering={offering} onOpen={()=>openResult("offering",offering.id,index+1)}/>)}</div>
            {!offerings.length && <p className="text-white/50 text-sm">No matching offerings.</p>}
          </section>}
        </div>}
        {search.hasMore && !search.error && <button disabled={search.loading} onClick={search.loadMore} className="mt-8 rounded-full border border-white/25 px-6 py-3 disabled:opacity-50">Load more results</button>}
      </>}
    </div>
  </main>;
}
function CreatorCard({creator:c,onOpen}:{creator:SearchCreator;onOpen:()=>void}) {
  return <Link href={`/profile/${encodeURIComponent(c.username)}`} onClick={onOpen} className="rounded-xl border border-white/10 p-4 hover:bg-white/5 flex gap-3">
    <img src={c.avatar_url || DEFAULT_AVATAR_URL} alt="" className="h-11 w-11 rounded-full object-cover"/>
    <div className="min-w-0"><p className="font-medium truncate">{c.full_name || `@${c.username}`}</p>
      {c.full_name && <p className="text-xs text-white/50">@{c.username}</p>}
      <p className="text-xs text-purple-300 mt-2">{c.related_match ? "Related match · " : ""}{c.match_reason}</p>
      <p className="text-sm text-white/60 line-clamp-2 mt-1">{c.match_evidence || c.tagline}</p>
    </div>
  </Link>;
}
function PostCard({post:p,onOpen}:{post:SearchPost;onOpen:()=>void}) {
  return <Link href={`/dashboard?postId=${encodeURIComponent(p.id)}`} onClick={onOpen} className="rounded-xl overflow-hidden border border-white/10 hover:bg-white/5">
    <div className="aspect-[3/4] bg-white/5">{p.poster_url ? <img src={p.poster_url} alt="" loading="lazy" className="w-full h-full object-cover"/> : p.media_url ? <video src={p.media_url} muted playsInline preload="none" className="w-full h-full object-cover"/> : <div className="h-full flex items-center justify-center text-white/40">View post</div>}</div>
    <div className="p-3"><p className="text-xs text-white/50">@{p.creator.username}</p><p className="text-sm line-clamp-2 mt-1">{p.caption || p.content || "View video"}</p></div>
  </Link>;
}
function OfferingCard({offering:o,onOpen}:{offering:SearchOffering;onOpen:()=>void}) {
  return <Link href={o.post_id ? `/dashboard?postId=${encodeURIComponent(o.post_id)}` : `/profile/${encodeURIComponent(o.creator_username)}`} onClick={onOpen} className="rounded-xl border border-white/10 p-4 hover:bg-white/5">
    <p className="font-medium">{o.title}</p><p className="text-sm text-white/50 mt-2">By @{o.creator_username}</p>
    <p className="text-sm text-purple-300 mt-3">View offering →</p>
  </Link>;
}
export default function SearchPageWrapper() {
  return <Suspense fallback={<p className="bg-black text-white p-6">Loading search…</p>}><SearchPage/></Suspense>;
}

