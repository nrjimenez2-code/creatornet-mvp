import { IntervalWatch } from "@/lib/qualifiedWatch";
import { aggregateInsights, mergeWatchedIntervals, validInsightUpdate } from "@/lib/videoInsights";
test("seek gaps, pauses, stalls, hidden gaps and rate changes earn no coverage", () => {
  const watch = new IntervalWatch();
  watch.sample(0,0,true); watch.sample(1000,1,true); watch.sample(1100,9,true);
  watch.resetSample(); watch.sample(2000,9,true); watch.sample(3000,10,true);
  watch.sample(4000,10,true); watch.sample(5000,10,false); watch.sample(6000,10,true);
  watch.sample(7000,12,true,2); watch.sample(8000,14,true,2);
  watch.sample(20000,20,true,2);
  expect(watch.seconds).toBe(3);
  expect(watch.intervals).toEqual([[0,1],[9,10],[12,14]]);
});
test("loops keep unique coverage capped while rewatch seconds increase", () => {
  const watch = new IntervalWatch();
  for(let loop=0;loop<2;loop++) { watch.resetSample(); watch.sample(loop*3000,0,true);watch.sample(loop*3000+1000,1,true);watch.sample(loop*3000+2000,2,true); }
  expect(watch.seconds).toBe(4);expect(watch.intervals).toEqual([[0,2]]);
  expect(mergeWatchedIntervals([[1,2],[0,1],[0.5,1.5],[4,5]])).toEqual([[0,2],[4,5]]);
});
test("a measured natural loop covers the final partial frame and opening; seek resets cannot credit the jump",()=>{
  const watch=new IntervalWatch();watch.sample(0,0,true);watch.sample(1000,1,true);watch.sample(1400,1.4,true);
  watch.sample(1600,0.1,true,1,1.5);expect(watch.intervals).toEqual([[0,1.5]]);expect(watch.seconds).toBeCloseTo(1.6);
  watch.resetSample();watch.sample(1700,1.4,true);watch.resetSample();watch.sample(1900,0.1,true,1,1.5);
  expect(watch.seconds).toBeCloseTo(1.6);
});
test("reports use playback starts as denominator, preserve measured rises and unknown sources", () => {
  const metrics = aggregateInsights({ sessions: 2,watch_seconds: 8,unique_seconds: 5,completions: 1,opening: 1,
    buckets:[1.5,0.5,2],sources:{search:1,unknown:1},collection_started_at:"2026-09-27",updated_at:"2026-09-27" },3);
  expect(metrics.averageWatchTime).toBe(4);expect(metrics.averagePercentageWatched).toBeCloseTo(83.333333);
  expect(metrics.completionRate).toBe(50);expect(metrics.threeSecondRetention).toBe(50);
  expect(metrics.retention.map(p=>p.percentage)).toEqual([75,25,100]);
  expect(metrics.sources.find(s=>s.source==="unknown")?.percentage).toBe(50);
});
test("unknown duration keeps session/watch/source metrics; no data never fabricates history", () => {
  const result = aggregateInsights(null,null);
  expect(result).toMatchObject({sampleCount:0,collectionStartedAt:null,retention:[],averagePercentageWatched:null});
});
test.each([NaN,Infinity,-1,43201])("invalid elapsed %p is rejected", seconds => {
  expect(validInsightUpdate({sequence:1,seconds,intervals:[]})).toBe(false);
});
test.each([[[1,1]], [[4,2]], [[-1,2]], [[0,Infinity]], Array.from({length:513},()=>[0,1])])("invalid intervals are bounded",intervals=>{
  expect(validInsightUpdate({sequence:1,seconds:1,intervals})).toBe(false);
});
