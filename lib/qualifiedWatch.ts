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
export function qualifiedThreshold(duration: number): number {
  return Number.isFinite(duration) && duration > 0
    ? Math.min(5, duration * 0.9)
    : 5;
}
