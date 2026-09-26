import { createRequire } from "node:module";
const { analyze } = createRequire(__filename)("../scripts/analyze-mobile-feed.cjs");
const run = (id: string, events: unknown[]) => ({ schema: 1, droppedEvents: 0, context: { runId: id, buildCommit: "fixture", surface: "safari", feed: "discover", mode: "candidate", iosVersion: "fixture", network: "wifi", powerMode: "normal", temperature: "cool", recordingId: id }, events });
const event = (kind: string, at: number, activation: number, detail = {}) => ({ kind, at, activation, detail });

test("missing warmed frames stay in the denominator and cannot produce a passing p95", () => {
  const report = analyze([run("a", [event("activation", 0, 1, { warmEligible: true }), event("moving-presentation", 90, 1), event("activation", 100, 2, { warmEligible: true })])]);
  expect(report.cohorts[0]).toEqual(expect.objectContaining({ warmedTransitions: 2, warmedMissingPresentation: 1, warmedP95Ms: null, warmedWithin150ms: false, sampleGate: false }));
  expect(report.acceptance).toBe("NOT_ESTABLISHED");
});
test("uncovered audible frames and muted-bridge onset are measured separately", () => {
  const report = analyze([run("a", [event("activation", 0, 1, { warmEligible: true }), event("moving-presentation", 50, 1), event("moving-frame", 240, 1), event("cover-removal", 300, 1)])]);
  expect(report.cohorts[0].warmed[0]).toEqual(expect.objectContaining({ latencyMs: 50, audiblePlayerMovingMs: 240 }));
  expect(report.rankedDelays[0].metric).toBe("activation-to-cover-removal");
});
test("cold transitions are separate and duplicate/truncated runs do not establish acceptance", () => {
  const a = run("a", [event("activation", 0, 1, { warmEligible: false }), event("moving-frame", 900, 1), event("cover-removal", 950, 1)]);
  const report = analyze([{ ...a, droppedEvents: 12 }, a]);
  expect(report.cohorts[0].transitions).toBe(1);
  expect(report.cohorts[0].warmedTransitions).toBe(0);
  expect(report.cohorts[0].coldTransitions[0].latencyMs).toBe(950);
  expect(report.invalidRuns).toHaveLength(2);
});
