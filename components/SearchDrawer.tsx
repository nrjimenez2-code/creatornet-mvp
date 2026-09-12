"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import SearchSuggestions from "@/components/SearchSuggestions";
import { readRecentSearches, subscribeRecentSearches, recentSearchesServerSnapshot, parseRecentSearches, saveRecentSearches } from "@/lib/recentSearches";

type Props = { open: boolean; onClose: () => void };
export default function SearchDrawer({open,onClose}:Props) {
  const router=useRouter();
  const inputRef=useRef<HTMLInputElement>(null);
  const dialogRef=useRef<HTMLElement>(null);
  const [query,setQuery]=useState("");
  const snapshot=useSyncExternalStore(subscribeRecentSearches,readRecentSearches,recentSearchesServerSnapshot);
  const recent=useMemo(()=>parseRecentSearches(snapshot),[snapshot]);
  useEffect(()=>{
    if(!open) return;
    const previousFocus=document.activeElement as HTMLElement | null;
    const previousOverflow=document.body.style.overflow;
    document.body.style.overflow="hidden";
    inputRef.current?.focus();
    router.prefetch("/search");
    const onKey=(event:KeyboardEvent)=>{
      if(event.key==="Escape") onClose();
      if(event.key==="Tab") {
        const nodes=Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('input,button:not([disabled]),a[href]') ?? []);
        const first=nodes[0],last=nodes[nodes.length-1];
        if(event.shiftKey && document.activeElement===first) {event.preventDefault();last?.focus();}
        else if(!event.shiftKey && document.activeElement===last) {event.preventDefault();first?.focus();}
      }
    };
    document.addEventListener("keydown",onKey);
    return ()=>{document.body.style.overflow=previousOverflow;document.removeEventListener("keydown",onKey);previousFocus?.focus();};
  },[open,onClose,router]);
  const submit=(term:string)=>{
    const value=term.trim();
    if(!value) return;
    saveRecentSearches([value,...recent.filter(r=>r.toLowerCase()!==value.toLowerCase())].slice(0,10));
    onClose();router.push(`/search?q=${encodeURIComponent(value)}`);
  };
  if(!open) return null;
  return <div className="fixed inset-0 z-[110]">
    <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true"/>
    <aside ref={dialogRef} role="dialog" aria-modal="true" aria-label="Search CreatorNet" className="absolute left-0 top-0 h-full w-[min(480px,95vw)] bg-[#141414] text-white shadow-2xl border-r border-white/10 flex flex-col">
      <div className="p-4 border-b border-white/10">
        <div className="flex justify-between items-center mb-4"><h2 className="font-semibold">Search CreatorNet</h2><button onClick={onClose} className="text-white/60 px-2 py-1">Close</button></div>
        <form onSubmit={event=>{event.preventDefault();submit(query);}} className="flex gap-2">
          <input ref={inputRef} value={query} maxLength={160} onChange={event=>setQuery(event.target.value)} aria-label="Search creators, topics, or services" placeholder="Creators, topics, or services" inputMode="search" className="min-w-0 flex-1 rounded-full border border-white/15 bg-black/40 px-4 py-3 outline-none focus:ring-2 focus:ring-[#4A35C7]"/>
          <button type="submit" disabled={!query.trim()} className="rounded-full bg-[#4A35C7] px-4 py-2 disabled:opacity-50">Search</button>
        </form>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <SearchSuggestions query={query} onPick={submit}/>
        <section className="mt-6"><h3 className="text-sm font-semibold text-white/80">Recent searches</h3>
          {!recent.length && <p className="mt-3 text-sm text-white/50">No searches yet.</p>}
          <ul className="mt-2 space-y-1">{recent.map(term=><li key={term}><button onClick={()=>submit(term)} className="text-left w-full rounded-lg px-3 py-2 text-white/70 hover:bg-white/5">{term}</button></li>)}</ul>
        </section>
      </div>
    </aside>
  </div>;
}
