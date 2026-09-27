"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Line, LineChart, ResponsiveContainer, XAxis, YAxis, CartesianGrid, ReferenceLine } from "recharts";
import { getActionSession } from "@/lib/actionSession";
import type { VideoInsights } from "@/lib/videoInsights";

const sourceNames = { discover: "Discover", following: "Following", profile: "Profile", search: "Search", direct: "Direct / shared", unknown: "Unknown" };
const stamp = (seconds: number) => {
  const tenths=Math.round(seconds*10),remainder=(tenths%600)/10;
  return `${Math.floor(tenths/600)}:${remainder.toFixed(tenths%10 ? 1 : 0).padStart(tenths%10 ? 4 : 2,"0")}`;
};
export default function VideoInsightsPanel({ postId }: { postId: string }) {
  const [data, setData] = useState<VideoInsights | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);
  const preview = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const controller = new AbortController(); let alive = true;
    void (async () => {
      try {
        const { data: auth, error: authError } = await getActionSession();
        if (authError || !auth.session?.access_token) throw Error("Please sign in again to view insights.");
        const response = await fetch(`/api/posts/${encodeURIComponent(postId)}/insights`, { credentials: "include", cache: "no-store",
          headers: { Authorization: `Bearer ${auth.session.access_token}` }, signal: AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]) });
        const body = await response.json();
        if (!response.ok) throw Error(body.error || "Could not load insights.");
        if (alive) { setData(body); setSelected(0); }
      } catch (error) { if (alive) setError(error instanceof Error ? error.message : "Could not load insights."); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; controller.abort(); };
  }, [postId, attempt]);
  function select(index: number) {
    setSelected(index);
    const time = data?.retention[index]?.time;
    if (preview.current && time !== undefined) { preview.current.pause(); preview.current.currentTime = time; }
  }
  if (loading) return <p role="status" className="py-16 text-center text-white/60">Loading insights…</p>;
  if (error) return <div className="py-12 text-center"><p role="alert" className="text-red-300">{error}</p>
    <button onClick={() => { setLoading(true);setError("");setAttempt(n=>n+1); }} className="mt-4 rounded-xl bg-[#4934c4] px-5 py-3">Try again</button></div>;
  if (!data) return null;
  const point = data.retention[selected];
  const lastPoint=data.retention.at(-1);
  // Extend the last measured bucket to its end, including videos shorter than one second.
  const chartPoints=lastPoint && data.duration ? [...data.retention,{time:data.duration,percentage:lastPoint.percentage}] : data.retention;
  const percent = (value: number | null) => value === null ? "Unavailable" : `${value.toFixed(1)}%`;
  const metrics = [
    ["Playback sessions", data.sampleCount.toLocaleString()],
    ["Average watch time", data.averageWatchTime === null ? "—" : `${data.averageWatchTime.toFixed(1)}s`],
    ["Average percentage watched", percent(data.averagePercentageWatched)],
    ["Completion rate", percent(data.completionRate)],
    ["Three-second retention", percent(data.threeSecondRetention)],
  ];
  return <div className="space-y-6">
    <div className="flex items-center gap-4">
      {data.poster && <Image src={data.poster} alt="" width={64} height={88} unoptimized className="h-22 w-16 rounded-lg object-cover" />}
      <p className="min-w-0 text-lg font-medium">{data.title}</p>
    </div>
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">{metrics.map(([label,value]) => <div key={label} className="rounded-xl border border-white/10 bg-white/5 p-3">
      <dt className="text-xs leading-5 text-white/60">{label}</dt><dd className="mt-1 text-xl font-semibold">{value}</dd></div>)}</dl>
    <section aria-labelledby="video-retention-title">
      <h3 id="video-retention-title" className="font-semibold">Audience retention</h3>
      <p className="mt-1 text-xs leading-5 text-white/55">Unique coverage of each part of the video. Replays add watch time and keep coverage capped at 100%.</p>
      {!data.duration ? <p className="mt-4 rounded-xl bg-white/5 p-5 text-sm text-white/65">Verified video duration is unavailable. Duration-based metrics and the retention graph will appear when metadata is available.</p>
      : !data.sampleCount ? <p className="mt-4 rounded-xl bg-white/5 p-5 text-sm text-white/65">No playback data yet. Insights begin with eligible playback after tracking is enabled.</p>
      : <>
        <div className="mt-4 h-52 touch-pan-y" onPointerDown={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          const fraction = Math.max(0,Math.min(1,(event.clientX-rect.left-40)/(rect.width-52)));
          const time=fraction*(data.duration ?? 0);
          select(data.retention.reduce((nearest,p,i)=>Math.abs(p.time-time)<Math.abs(data.retention[nearest].time-time)?i:nearest,0));
        }}>
          <ResponsiveContainer width="100%" height="100%"><LineChart data={chartPoints} margin={{left:0,right:12,top:8,bottom:0}} accessibilityLayer={false} role="img" aria-label="Audience retention by video time">
            <CartesianGrid stroke="#ffffff12" vertical={false}/>
            <XAxis dataKey="time" type="number" domain={[0,data.duration]} tickFormatter={stamp} stroke="#ffffff60" fontSize={11}/>
            <YAxis domain={[0,100]} width={40} tickFormatter={n=>`${n}%`} stroke="#ffffff60" fontSize={11}/>
            <Line dataKey="percentage" type="linear" stroke="#a78bfa" strokeWidth={2} dot={false} activeDot={false} isAnimationActive={false}/>
            {point && <ReferenceLine x={point.time} stroke="#ffffff80"/>}
          </LineChart></ResponsiveContainer>
        </div>
        <label htmlFor={`insight-timeline-${postId}`} className="mt-2 block text-sm">Select a timestamp</label>
        <input id={`insight-timeline-${postId}`} type="range" min={0} max={Math.max(0,data.retention.length-1)} step={1} value={selected}
          onChange={event=>select(Number(event.target.value))} aria-valuetext={point ? `${stamp(point.time)}, ${point.percentage.toFixed(1)} percent` : "No data"}
          className="mt-2 w-full accent-violet-400" />
        <p aria-live="polite" className="mt-1 text-sm text-white/75">{point ? `${stamp(point.time)} · ${point.percentage.toFixed(1)}% watched` : ""}</p>
        {data.previewUrl && <video ref={preview} src={data.previewUrl} poster={data.poster ?? undefined} muted playsInline preload="metadata"
          aria-label="Paused insights preview" data-insights-preview="true" onPlay={event=>event.currentTarget.pause()}
          onLoadedMetadata={()=>{ if (preview.current && point) preview.current.currentTime=point.time; }} className="mt-3 h-44 w-full rounded-xl bg-black object-contain"/>}
      </>}
      {data.limited && data.sampleCount>0 && <p className="mt-3 text-sm text-amber-200">Limited data · fewer than 50 eligible sessions</p>}
      <p className="mt-2 text-xs leading-5 text-white/50">Sample: {data.sampleCount.toLocaleString()} eligible sessions.
        {data.collectionStartedAt ? ` Collected since ${new Date(data.collectionStartedAt).toLocaleDateString()}.` : " Collection has not started for this video."}</p>
    </section>
    <section aria-labelledby="video-sources-title"><h3 id="video-sources-title" className="font-semibold">View sources</h3>
      <ul className="mt-3 space-y-3">{data.sources.map(source=><li key={source.source} className="flex justify-between text-sm">
        <span className="text-white/70">{sourceNames[source.source]}</span><span>{source.percentage.toFixed(1)}%</span></li>)}</ul>
    </section>
    <p className="text-xs leading-5 text-white/45">Playback sessions include immediate exits. These are separate from qualified views and unique viewers. Historical retention before collection began is unavailable.</p>
  </div>;
}
