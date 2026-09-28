import { mergeWatchedIntervals, type WatchedInterval } from "./videoInsights";
/** Accumulate visible playback, never playhead position. Seeking and stalls earn nothing. */
export class QualifiedWatch {
  seconds = 0;
  private previous: { at: number; position: number } | null = null;
  sample(at: number, position: number, playing: boolean, rate = 1): number {
    const last = this.previous;
    this.previous =
      playing && Number.isFinite(at) && Number.isFinite(position)
        ? { at, position }
        : null;
    if (!last || !this.previous || rate <= 0 || !Number.isFinite(rate))
      return this.seconds;
    const elapsed = (at - last.at) / 1000;
    const moved = position - last.position;
    // A long background gap or a seek must not become watched time.
    if (
      elapsed > 0 &&
      elapsed <= 2 &&
      moved > 0 &&
      moved <= elapsed * rate + 0.35
    ) {
      this.seconds += Math.min(elapsed, moved / rate);
    }
    return this.seconds;
  }
  resetSample() {
    this.previous = null;
  }
}
/** Interval measurement for insights, kept separate from existing dashboard counters. */
export class IntervalWatch extends QualifiedWatch {
  intervals: WatchedInterval[] = [];
  private intervalPrevious: { at: number; position: number; rate: number } | null = null;
  sample(at: number, position: number, playing: boolean, rate = 1, loopDuration?: number): number {
    const previous = this.intervalPrevious;
    this.intervalPrevious = playing && Number.isFinite(at) && Number.isFinite(position) && rate > 0 && rate <= 16
      ? { at, position, rate } : null;
    if (!previous || !this.intervalPrevious || rate !== previous.rate) return this.seconds;
    const elapsed = (at - previous.at) / 1000;
    const moved = position - previous.position;
    const wrapped = moved < 0 && typeof loopDuration === "number" && Number.isFinite(loopDuration) &&
      loopDuration > previous.position && position < 0.5 && previous.position > loopDuration-0.5;
    const advance = wrapped ? loopDuration! - previous.position + position : moved;
    if (elapsed > 0 && elapsed <= 2 && advance > 0 && advance <= elapsed * rate + 0.1) {
      this.seconds += Math.min(elapsed, advance / rate);
      this.intervals = mergeWatchedIntervals([...this.intervals, ...(wrapped ? [[previous.position,loopDuration!],[0,position]] as WatchedInterval[] : [[previous.position, position]] as WatchedInterval[])]);
    }
    return this.seconds;
  }
  resetSample() { super.resetSample(); this.intervalPrevious = null; }
}
export function qualifiedThreshold(duration: number): number {
  return Number.isFinite(duration) && duration > 0
    ? Math.min(5, duration * 0.9)
    : 5;
}
