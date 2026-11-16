import { planRoute, type RoutableDisruption, type RoutableSegment } from "@/lib/routing";
import { matchDisruptionToSegments } from "@/lib/matching";
import { listSourceStatus } from "@/lib/ingest";
import { extractDisruption } from "@/lib/nlp";

export type ScenarioResult = {
  name: string;
  passed: boolean;
  detail: string;
};

export type SelfTestReport = {
  startedAt: string;
  passed: number;
  failed: number;
  scenarios: ScenarioResult[];
};

const ORIGIN = { lat: 23.0, lng: 72.5 };
const DEST = { lat: 23.004, lng: 72.505 };

function segment(
  id: number,
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  roadName: string,
  nodes: [string, string],
  overrides: Partial<RoutableSegment> = {},
): RoutableSegment {
  return {
    id,
    segmentCode: `T-${String(id).padStart(2, "0")}`,
    roadName,
    city: "Ahmedabad",
    roadClass: "arterial",
    startNode: nodes[0],
    endNode: nodes[1],
    startLat: from.lat,
    startLng: from.lng,
    endLat: to.lat,
    endLng: to.lng,
    geometry: [
      [from.lng, from.lat],
      [to.lng, to.lat],
    ],
    distanceMeters: Math.round(Math.hypot((to.lat - from.lat) * 111320, (to.lng - from.lng) * 111320 * Math.cos((23 * Math.PI) / 180))),
    baseSpeedKph: 45,
    trafficLevel: "low",
    status: "open",
    ...overrides,
  };
}

/** Direct A→B→C→D and a slightly longer A→E→F→D alternative. */
function network(): RoutableSegment[] {
  const A = { lat: 23.0, lng: 72.5 };
  const B = { lat: 23.002, lng: 72.5 };
  const C = { lat: 23.004, lng: 72.5 };
  const D = { lat: 23.004, lng: 72.505 };
  const E = { lat: 23.0, lng: 72.506 };
  const F = { lat: 23.002, lng: 72.506 };
  return [
    segment(1, A, B, "Direct Road", ["nA", "nB"]),
    segment(2, B, C, "Direct Road", ["nB", "nC"]),
    segment(3, C, D, "Direct Road", ["nC", "nD"]),
    segment(4, A, E, "Alt Road", ["nA", "nE"]),
    segment(5, E, F, "Alt Road", ["nE", "nF"]),
    segment(6, F, D, "Alt Road", ["nF", "nD"]),
  ];
}

function disruption(overrides: Partial<RoutableDisruption> & { id: number; segmentId: number }): RoutableDisruption {
  return {
    type: "construction",
    severity: "moderate",
    status: "active",
    title: "Test event",
    lat: 23.002,
    lng: 72.5,
    confidence: 0.9,
    verification: "verified",
    direction: "both",
    startsAt: new Date(),
    eventEndsAt: null,
    ...overrides,
  };
}

async function run(
  name: string,
  fn: () => { passed: boolean; detail: string } | Promise<{ passed: boolean; detail: string }>,
): Promise<ScenarioResult> {
  try {
    const result = await fn();
    return { name, passed: result.passed, detail: result.detail };
  } catch (error) {
    return { name, passed: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function runSelfTest(): Promise<SelfTestReport> {
  const startedAt = new Date().toISOString();
  const segments = network();
  const scenarios: ScenarioResult[] = [];

  // 1. Normal conditions
  scenarios.push(
    await run("1. Normal road conditions", () => {
      const plan = planRoute({ origin: ORIGIN, destination: DEST, segments, disruptions: [] });
      const fastest = plan.fastest;
      return {
        passed: Boolean(fastest) && fastest!.roadNames.every((road) => road === "Direct Road"),
        detail: fastest
          ? `fastest=${fastest.label} via ${fastest.roadNames.join(",")} in ${fastest.durationSeconds}s, ${fastest.distanceMeters}m, ${plan.options.length} option(s)`
          : "no route found",
      };
    }),
  );

  // 2. Heavy traffic
  scenarios.push(
    await run("2. Heavy traffic increases travel time", () => {
      const clear = planRoute({ origin: ORIGIN, destination: DEST, segments, disruptions: [] }).fastest!;
      const congested = planRoute({
        origin: ORIGIN,
        destination: DEST,
        segments: segments.map((s) => (s.roadName === "Direct Road" ? { ...s, trafficLevel: "severe" } : s)),
        disruptions: [],
      }).fastest!;
      return {
        passed: congested.durationSeconds > clear.durationSeconds * 1.2,
        detail: `clear=${clear.durationSeconds}s vs congested=${congested.durationSeconds}s`,
      };
    }),
  );

  // 3. Complete road closure
  scenarios.push(
    await run("3. Complete road closure excludes the road", () => {
      const base = planRoute({ origin: ORIGIN, destination: DEST, segments, disruptions: [] }).fastest!;
      const plan = planRoute({
        origin: ORIGIN,
        destination: DEST,
        segments,
        disruptions: [disruption({ id: 1, segmentId: 1, type: "closure", severity: "critical", confidence: 0.95 })],
      });
      const fastest = plan.fastest!;
      return {
        passed: fastest.blockedSegmentsAvoided >= 1 && fastest.durationSeconds > base.durationSeconds,
        detail: `closed segment removed from the search: ${base.durationSeconds}s → ${fastest.durationSeconds}s via ${fastest.roadNames.join(",")}; ${fastest.blockedSegmentsAvoided} blocked segment(s) avoided`,
      };
    }),
  );

  // 4. Partial construction obstruction
  scenarios.push(
    await run("4. Partial construction penalises but keeps the road", () => {
      const base = planRoute({ origin: ORIGIN, destination: DEST, segments, disruptions: [] }).fastest!;
      const plan = planRoute({
        origin: ORIGIN,
        destination: DEST,
        segments,
        disruptions: [disruption({ id: 2, segmentId: 1, type: "construction", severity: "moderate", confidence: 0.85 })],
      });
      const fastest = plan.fastest!;
      return {
        passed:
          fastest.durationSeconds > base.durationSeconds &&
          fastest.roadNames.includes("Direct Road") &&
          fastest.breakdown.disruptionSeconds > 0,
        detail: `base=${base.durationSeconds}s → with work=${fastest.durationSeconds}s (disruption penalty ${fastest.breakdown.disruptionSeconds}s), road still used`,
      };
    }),
  );

  // 5. Metro construction
  scenarios.push(
    await run("5. Metro construction applies a penalty", () => {
      const base = planRoute({ origin: ORIGIN, destination: DEST, segments, disruptions: [] }).fastest!;
      const plan = planRoute({
        origin: ORIGIN,
        destination: DEST,
        segments,
        disruptions: [disruption({ id: 3, segmentId: 2, type: "metro_work", severity: "high", confidence: 0.9 })],
      });
      const fastest = plan.fastest!;
      return {
        passed: fastest.durationSeconds > base.durationSeconds && fastest.disruptions.some((d) => d.type === "metro_work"),
        detail: `base=${base.durationSeconds}s → metro work=${fastest.durationSeconds}s, disruption reported on route: ${fastest.disruptions.length}`,
      };
    }),
  );

  // 6. Waterlogging (verified, high) blocks
  scenarios.push(
    await run("6. Verified severe waterlogging blocks the road", () => {
      const base = planRoute({ origin: ORIGIN, destination: DEST, segments, disruptions: [] }).fastest!;
      const plan = planRoute({
        origin: ORIGIN,
        destination: DEST,
        segments,
        disruptions: [disruption({ id: 4, segmentId: 1, type: "waterlogging", severity: "high", confidence: 0.9, verification: "verified" })],
      });
      const fastest = plan.fastest!;
      return {
        passed: fastest.blockedSegmentsAvoided >= 1 && fastest.durationSeconds > base.durationSeconds,
        detail: `waterlogged segment avoided: ${base.durationSeconds}s → ${fastest.durationSeconds}s via ${fastest.roadNames.join(",")}`,
      };
    }),
  );

  // 7. Multiple disruptions
  scenarios.push(
    await run("7. Multiple simultaneous disruptions", () => {
      const plan = planRoute({
        origin: ORIGIN,
        destination: DEST,
        segments,
        disruptions: [
          disruption({ id: 5, segmentId: 1, type: "waterlogging", severity: "high", confidence: 0.9 }),
          disruption({ id: 6, segmentId: 5, type: "construction", severity: "moderate", confidence: 0.8 }),
        ],
      });
      const fastest = plan.fastest!;
      return {
        passed: fastest.roadNames.includes("Alt Road") && fastest.disruptions.length >= 1,
        detail: `route via ${fastest.roadNames.join(",")} in ${fastest.durationSeconds}s with ${fastest.disruptions.length} disruption(s) reported`,
      };
    }),
  );

  // 8. Expired events stop affecting routing
  scenarios.push(
    await run("8. Expired events no longer affect routing", () => {
      const now = new Date();
      const base = planRoute({ origin: ORIGIN, destination: DEST, segments, disruptions: [], now }).fastest!;
      const plan = planRoute({
        origin: ORIGIN,
        destination: DEST,
        segments,
        disruptions: [
          disruption({
            id: 7,
            segmentId: 1,
            type: "closure",
            severity: "critical",
            confidence: 0.95,
            eventEndsAt: new Date(now.getTime() - 3600_000),
            startsAt: new Date(now.getTime() - 7200_000),
          }),
        ],
        now,
      });
      const fastest = plan.fastest!;
      return {
        passed: fastest.durationSeconds === base.durationSeconds && fastest.roadNames.includes("Direct Road"),
        detail: `expired closure ignored: duration unchanged at ${fastest.durationSeconds}s`,
      };
    }),
  );

  // 9. Newly reported disruption during travel
  scenarios.push(
    await run("9. New disruption during travel triggers a reroute", () => {
      const before = planRoute({ origin: ORIGIN, destination: DEST, segments, disruptions: [] }).fastest!;
      const after = planRoute({
        origin: ORIGIN,
        destination: DEST,
        segments,
        disruptions: [disruption({ id: 8, segmentId: 2, type: "closure", severity: "critical", confidence: 0.95 })],
      }).fastest!;
      return {
        passed: after.durationSeconds !== before.durationSeconds || after.roadNames.join() !== before.roadNames.join(),
        detail: `before: ${before.durationSeconds}s via ${before.roadNames.join(",")} → after: ${after.durationSeconds}s via ${after.roadNames.join(",")}`,
      };
    }),
  );

  // 10. Conflicting reports
  scenarios.push(
    await run("10. Conflicting reports resolve to the trusted event", () => {
      const plan = planRoute({
        origin: ORIGIN,
        destination: DEST,
        segments,
        disruptions: [
          disruption({ id: 9, segmentId: 1, type: "closure", severity: "critical", confidence: 0.95, verification: "verified" }),
          disruption({ id: 10, segmentId: 1, type: "traffic", severity: "low", confidence: 0.35, verification: "unverified" }),
        ],
      });
      const base = planRoute({ origin: ORIGIN, destination: DEST, segments, disruptions: [] }).fastest!;
      const fastest = plan.fastest!;
      return {
        passed:
          fastest.blockedSegmentsAvoided >= 1 &&
          fastest.dataQuality.verified >= 1 &&
          fastest.dataQuality.unverified >= 1 &&
          fastest.durationSeconds > base.durationSeconds,
        detail: `verified closure wins over the low-confidence report: ${base.durationSeconds}s → ${fastest.durationSeconds}s; quality verified=${fastest.dataQuality.verified} unverified=${fastest.dataQuality.unverified} avgConfidence=${fastest.dataQuality.averageConfidence}`,
      };
    }),
  );

  // 11. No alternative available
  scenarios.push(
    await run("11. No alternative route available", () => {
      const plan = planRoute({
        origin: ORIGIN,
        destination: DEST,
        segments: segments.map((s) => ({ ...s, status: "closed" })),
        disruptions: [],
      });
      return { passed: plan.fastest === null, detail: plan.fastest ? "unexpected route" : "correctly returned no feasible route" };
    }),
  );

  // Integration checks against live data
  scenarios.push(
    await run("12. NLP extraction (road, category, severity, time window)", () => {
      const result = extractDisruption(
        "Ashram Road will be fully closed for drainage work from 10:00 to 17:00 today due to pipeline repair. Traffic diverted via Ring Road.",
      );
      const passed =
        result.roadName !== null &&
        ["drainage", "pipeline", "closure", "diversion"].includes(result.category) &&
        ["high", "critical"].includes(result.severity) &&
        result.endsAt !== null &&
        result.confidence >= 0.7;
      return {
        passed,
        detail: `road=${result.roadName} category=${result.category} severity=${result.severity} window=${result.startsAt?.toISOString().slice(11, 16)}–${result.endsAt?.toISOString().slice(11, 16)} confidence=${result.confidence}`,
      };
    }),
  );

  scenarios.push(
    await run("13. Geospatial segment matching", async () => {
      const match = await matchDisruptionToSegments({ lat: 23.0106, lng: 72.5651, roadName: "Ashram Road" });
      return {
        passed: match.segmentIds.length > 0,
        detail: `method=${match.method} segments=${match.segmentIds.join(",") || "none"} confidence=${match.confidence} needsReview=${match.needsReview}`,
      };
    }),
  );

  const passed = scenarios.filter((scenario) => scenario.passed).length;
  return {
    startedAt,
    passed,
    failed: scenarios.length - passed,
    scenarios,
  };
}

export async function sourceStatusCheck(): Promise<{ key: string; status: string; lastError: string | null }[]> {
  const rows = await listSourceStatus();
  return rows.map((row) => ({ key: row.key, status: row.status, lastError: row.lastError }));
}
