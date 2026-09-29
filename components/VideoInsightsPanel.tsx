"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Line, LineChart, ResponsiveContainer, XAxis, YAxis, CartesianGrid, ReferenceLine } from "recharts";
import { getActionSession } from "@/lib/actionSession";
import type { VideoInsights } from "@/lib/videoInsights";
import styles from "./videoInsights.module.css";
import VideoInsightsSkeleton from "./VideoInsightsSkeleton";

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
  if (loading) return <VideoInsightsSkeleton />;
  if (error) return <div className={styles.message}><p role="alert" className={styles.error}>{error}</p>
    <button type="button" onClick={() => { setLoading(true);setError("");setAttempt(n=>n+1); }} className={styles.retry}>Try again</button></div>;
  if (!data) return null;
  const point = data.retention[selected];
  const lastPoint=data.retention.at(-1);
  // Extend the last measured bucket to its end, including videos shorter than one second.
  const chartPoints=lastPoint && data.duration ? [...data.retention,{time:data.duration,percentage:lastPoint.percentage}] : data.retention;
  const percent = (value: number | null) => value === null ? "Unavailable" : `${value.toFixed(1)}%`;
  const summary = [
    ["Video plays", data.sampleCount.toLocaleString()],
    ["Avg. watch time", data.averageWatchTime === null ? "—" : `${data.averageWatchTime.toFixed(1)}s`],
    ["Completion rate", percent(data.completionRate)],
  ];
  const activeSources = data.sources.filter(source => source.count > 0);
  return <div className={styles.panel}>
    <div className={styles.videoHeading}>
      {data.poster ? <Image src={data.poster} alt="" width={42} height={56} unoptimized className={styles.poster} />
        : <div className={styles.posterFallback} aria-hidden="true" />}
      <div className={styles.videoHeadingText}><h3>{data.title}</h3>
        <p className={styles.meta}>{data.collectionStartedAt ? `Insights since ${new Date(data.collectionStartedAt).toLocaleDateString()}` : "Insights have not started yet"}
          {data.duration ? ` · ${stamp(data.duration)} video` : ""}</p></div>
    </div>

    <dl className={styles.summary}>{summary.map(([label,value]) => <div key={label}>
      <dt>{label}</dt><dd>{value}</dd></div>)}</dl>

    <section aria-labelledby={`insight-retention-${postId}`} className={styles.retention}>
      <div className={styles.sectionHead}><h4 id={`insight-retention-${postId}`}>Audience retention</h4><span>{data.sampleCount.toLocaleString()} video plays</span></div>
        <p className={styles.description}>See where people keep watching. Select a moment to preview it.</p>
        {!data.duration ? <p className={styles.empty}>Verified video duration is unavailable. Duration-based metrics and the retention graph will appear when metadata is available.</p>
        : !data.sampleCount ? <p className={styles.empty}>No playback data yet. Insights begin with eligible playback after tracking is enabled.</p>
        : <>
          <div className={styles.chart} onPointerDown={event => {
            const rect = event.currentTarget.getBoundingClientRect();
            const fraction = Math.max(0,Math.min(1,(event.clientX-rect.left-40)/(rect.width-52)));
            const time=fraction*(data.duration ?? 0);
            select(data.retention.reduce((nearest,p,i)=>Math.abs(p.time-time)<Math.abs(data.retention[nearest].time-time)?i:nearest,0));
          }}>
            <ResponsiveContainer width="100%" height="100%"><LineChart data={chartPoints} margin={{left:0,right:12,top:8,bottom:0}} accessibilityLayer={false} role="img" aria-label="Audience retention by video time">
              <CartesianGrid stroke="#29292f" strokeDasharray="3 5" vertical={false}/>
              <XAxis dataKey="time" type="number" domain={[0,data.duration]} tickFormatter={stamp} stroke="#a4a4ae" fontSize={11}/>
              <YAxis domain={[0,100]} width={40} tickFormatter={n=>`${n}%`} stroke="#a4a4ae" fontSize={11}/>
              <Line dataKey="percentage" type="linear" stroke="#7659ef" strokeWidth={2} dot={false} activeDot={false} isAnimationActive={false}/>
              {point && <ReferenceLine x={point.time} stroke="#c9b9ff"/>}
            </LineChart></ResponsiveContainer>
          </div>
          <div className={styles.moment}>
            <div className={styles.momentControls}>
              <div className={styles.momentHeading}><label htmlFor={`insight-timeline-${postId}`}>Selected moment</label><strong>{point ? stamp(point.time) : "—"}</strong></div>
              <input id={`insight-timeline-${postId}`} type="range" min={0} max={Math.max(0,data.retention.length-1)} step={1} value={selected}
                onChange={event=>select(Number(event.target.value))} aria-valuetext={point ? `${stamp(point.time)}, ${point.percentage.toFixed(1)} percent` : "No data"} />
              <div aria-live="polite" className={styles.momentFooter}><span>{point ? `${point.percentage.toFixed(1)}% watched` : ""}</span><span>{stamp(data.duration)}</span></div>
            </div>
            {data.previewUrl && <video ref={preview} src={data.previewUrl} poster={data.poster ?? undefined} muted playsInline preload="metadata"
              aria-label="Paused insights preview" data-insights-preview="true" onPlay={event=>event.currentTarget.pause()}
              onLoadedMetadata={()=>{ if (preview.current && point) preview.current.currentTime=point.time; }} className={styles.preview}/>}
          </div>
        </>}
        {data.limited && data.sampleCount>0 && <p className={styles.limited}>Limited data · fewer than 50 video plays</p>}
    </section>

    <details className={styles.disclosure}>
      <summary><span>More playback metrics</span><span className={styles.summaryHint}>2 metrics</span></summary>
      <div className={styles.disclosureBody}>
        <dl className={styles.metricRows}>
          <div><dt>Average percentage watched</dt><dd>{percent(data.averagePercentageWatched)}</dd></div>
          <div><dt>Three-second retention</dt><dd>{percent(data.threeSecondRetention)}</dd></div>
        </dl>
      </div>
    </details>

    <details className={styles.disclosure}>
      <summary><span>View sources</span><span className={styles.summaryHint}>Where playback started</span></summary>
      <div className={styles.disclosureBody}>
        {activeSources.length ? <ul className={styles.sources}>{activeSources.map(source=><li key={source.source}>
          <div><span>{sourceNames[source.source]}</span><strong>{source.percentage.toFixed(1)}%</strong></div>
          <span className={styles.sourceTrack}><span style={{width:`${Math.max(0,Math.min(100,source.percentage))}%`}}/></span>
        </li>)}</ul> : <p className={styles.empty}>No source data yet.</p>}
      </div>
    </details>

    <details className={styles.disclosure}>
      <summary><span>About these numbers</span><span className={styles.summaryHint}>What is counted</span></summary>
      <div className={styles.disclosureBody}>
        <p className={styles.definition}>Video plays count eligible starts, including immediate exits. They are separate from qualified views and unique viewers.</p>
        <p className={styles.definition}>Replaying during the same visit adds watch time without another play. Coverage of each moment is capped at 100%. Historical retention before collection began is unavailable.</p>
      </div>
    </details>
    <p className={styles.foot}>The video preview stays paused and does not count as a play.
      {data.collectionStartedAt ? ` Data collected since ${new Date(data.collectionStartedAt).toLocaleDateString()}.` : " Collection has not started for this video."}</p>
  </div>;
}
