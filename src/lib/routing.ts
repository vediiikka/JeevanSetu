import { bearing, haversine, polylineLength, projectOnPolyline, type LatLng } from "@/lib/geo";
import { SEVERITY_MULTIPLIER, type DisruptionSeverity } from "@/lib/domain";

export type RoutableSegment = {
  id: number;
  segmentCode: string;
  roadName: string;
  city: string;
  roadClass: string;
  startNode: string;
  endNode: string;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  geometry: [number, number][];
  distanceMeters: number;
  baseSpeedKph: number;
  trafficLevel: string;
  status: string;
};

export type RoutableDisruption = {
  id: number;
  segmentId: number | null;
  type: string;
  severity: string;
  status: string;
  title: string;
  lat: number;
  lng: number;
  confidence?: number;
  verification?: string;
  direction?: string;
  startsAt?: string | Date | null;
  eventEndsAt?: string | Date | null;
  sourceKey?: string;
  needsReview?: boolean;
};

export type RouteBreakdown = {
  baseSeconds: number;
  trafficSeconds: number;
  disruptionSeconds: number;
  connectorSeconds: number;
};

export type RouteDataQuality = {
  verified: number;
  community: number;
  unverified: number;
  lowConfidence: number;
  expired: number;
  averageConfidence: number;
};

export type RouteStepView = {
  name: string;
  instruction: string;
  distanceMeters: number;
  startMeters: number;
  durationSeconds: number;
};

/** A coloured piece of the route: congestion level plus [lng, lat] points. */
export type TrafficSegment = { level: "green" | "orange" | "red"; points: [number, number][] };

export type RouteOption = {
  label: string;
  /** Stable identifier: fastest | fast | slow (or alt1, alt2 for road-service options). */
  key?: string;
  engine?: string;
  /** How the route was computed, for transparency in the UI. */
  algorithm?: string;
  steps?: RouteStepView[];
  /** Traffic heatmap for the route, coloured green / orange / red. */
  segments?: TrafficSegment[];
  /** Share (0..1) of this route's length that it has in common with the fastest route. */
  overlapWithFastest?: number;
  /** Share of the route's length in green / orange / red traffic (sums to about 100). */
  trafficMix?: { green: number; orange: number; red: number };
  distinct?: boolean;
  nodesExpanded?: number;
  computeMs?: number;
  geometry: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  freeFlowSeconds: number;
  delaySeconds: number;
  traffic: "low" | "moderate" | "heavy" | "severe";
  roadNames: string[];
  disruptions: { id: number; title: string; type: string; severity: string; roadName: string; confidence: number; verification: string }[];
  blockedSegmentsAvoided: number;
  breakdown: RouteBreakdown;
  dataQuality: RouteDataQuality;
};

export type RoutePlan = {
  origin: LatLng;
  destination: LatLng;
  snappedOrigin: LatLng;
  snappedDestination: LatLng;
  options: RouteOption[];
  fastest: RouteOption | null;
  generatedAt: string;
  networkSize: { nodes: number; edges: number };
};

const BLOCKING_TYPES = new Set(["closure", "waterlogging", "damaged_road"]);
const TRUSTED_VERIFICATION = new Set(["verified", "community"]);
const LEVEL_FACTOR: Record<string, number> = { low: 1, moderate: 0.86, heavy: 0.68, severe: 0.5 };
const CONNECTOR_SPEED_KPH = 22;
const MIN_CONFIDENCE_FOR_BLOCK = 0.6;

export function hourTrafficFactor(hour: number): number {
  if (hour >= 9 && hour < 12) return 0.62;
  if (hour >= 17 && hour < 21) return 0.58;
  if (hour >= 12 && hour < 17) return 0.82;
  if (hour >= 21 || hour < 6) return 1;
  return 0.9;
}

export function currentTrafficLevel(baseLevel: string, hour: number): "low" | "moderate" | "heavy" | "severe" {
  const combined = (LEVEL_FACTOR[baseLevel] ?? 0.86) * hourTrafficFactor(hour);
  if (combined >= 0.9) return "low";
  if (combined >= 0.75) return "moderate";
  if (combined >= 0.6) return "heavy";
  return "severe";
}

type Graph = {
  nodes: Map<string, LatLng>;
  adjacency: Map<string, { segment: RoutableSegment; other: string }[]>;
};

function buildGraph(segments: RoutableSegment[]): Graph {
  const nodes = new Map<string, LatLng>();
  const adjacency = new Map<string, { segment: RoutableSegment; other: string }[]>();
  const push = (from: string, to: string, segment: RoutableSegment) => {
    const list = adjacency.get(from) ?? [];
    list.push({ segment, other: to });
    adjacency.set(from, list);
  };
  for (const s of segments) {
    nodes.set(s.startNode, { lat: s.startLat, lng: s.startLng });
    nodes.set(s.endNode, { lat: s.endLat, lng: s.endLng });
    push(s.startNode, s.endNode, s);
    push(s.endNode, s.startNode, s);
  }
  return { nodes, adjacency };
}

type EdgeSnap = { segment: RoutableSegment; point: LatLng; alongMeters: number; distanceMeters: number };

function nearestEdgePoint(segments: RoutableSegment[], point: LatLng): EdgeSnap | null {
  let best: EdgeSnap | null = null;
  for (const segment of segments) {
    const line = segment.geometry.map(([lng, lat]) => ({ lat, lng }));
    const projection = projectOnPolyline(point, line);
    if (!best || projection.distanceMeters < best.distanceMeters) {
      best = { segment, point: projection.point, alongMeters: projection.alongMeters, distanceMeters: projection.distanceMeters };
    }
  }
  return best;
}

function closerEndpoint(segment: RoutableSegment, point: LatLng): string {
  const start = { lat: segment.startLat, lng: segment.startLng };
  const end = { lat: segment.endLat, lng: segment.endLng };
  return haversine(point, start) <= haversine(point, end) ? segment.startNode : segment.endNode;
}

export function isExpired(disruption: RoutableDisruption, now: Date): boolean {
  if (!disruption.eventEndsAt) return false;
  return new Date(disruption.eventEndsAt).getTime() <= now.getTime();
}

/** Only trusted, sufficiently confident, currently-valid events may block a road. */
export function isBlocking(disruption: RoutableDisruption, now: Date): boolean {
  if (disruption.status !== "active") return false;
  if (!BLOCKING_TYPES.has(disruption.type)) return false;
  if (!["high", "critical"].includes(disruption.severity)) return false;
  if (!TRUSTED_VERIFICATION.has(disruption.verification ?? "verified")) return false;
  if ((disruption.confidence ?? 1) < MIN_CONFIDENCE_FOR_BLOCK) return false;
  if (isExpired(disruption, now)) return false;
  return true;
}

function isBlocked(segment: RoutableSegment, disruptions: RoutableDisruption[], now: Date): boolean {
  if (segment.status === "closed") return true;
  return disruptions.some((d) => d.segmentId === segment.id && isBlocking(d, now));
}

/** Older / about-to-expire events have less influence on the weight. */
export function freshnessFactor(disruption: RoutableDisruption, now: Date): number {
  if (disruption.eventEndsAt) {
    const remaining = new Date(disruption.eventEndsAt).getTime() - now.getTime();
    if (remaining <= 0) return 0;
    if (remaining < 3600_000) return 0.7;
    return 1;
  }
  if (disruption.startsAt) {
    const ageHours = (now.getTime() - new Date(disruption.startsAt).getTime()) / 3600_000;
    if (ageHours > 48) return 0.6;
    if (ageHours > 24) return 0.8;
  }
  return 1;
}

/** Direction of travel matters: a northbound closure barely affects southbound traffic. */
function directionFactor(disruption: RoutableDisruption, segment: RoutableSegment): number {
  const direction = (disruption.direction ?? "both").toLowerCase();
  if (!direction || direction === "both") return 1;
  const from = { lat: segment.startLat, lng: segment.startLng };
  const to = { lat: segment.endLat, lng: segment.endLng };
  const segmentBearing = bearing(from, to);
  const compass: Record<string, number> = { northbound: 0, eastbound: 90, southbound: 180, westbound: 270 };
  for (const [key, degrees] of Object.entries(compass)) {
    if (!direction.includes(key)) continue;
    const difference = Math.abs(((segmentBearing - degrees + 540) % 360) - 180);
    if (difference > 135) return 0.35;
    if (difference < 45) return 1.15;
    return 1;
  }
  return 0.8; // textual "from X to Y" direction we cannot map onto a bearing
}

function penaltyMultiplier(disruption: RoutableDisruption, segment: RoutableSegment, now: Date): number {
  const base = (SEVERITY_MULTIPLIER[disruption.severity as DisruptionSeverity] ?? 1.3) - 1;
  const confidence = disruption.confidence ?? 1;
  return 1 + base * confidence * freshnessFactor(disruption, now) * directionFactor(disruption, segment);
}

function segmentPenalty(segment: RoutableSegment, disruptions: RoutableDisruption[], now: Date): number {
  let multiplier = 1;
  for (const disruption of disruptions) {
    if (disruption.segmentId !== segment.id) continue;
    if (isExpired(disruption, now)) continue;
    multiplier = Math.max(multiplier, penaltyMultiplier(disruption, segment, now));
  }
  return multiplier;
}

type SegmentCost = { total: number; base: number; traffic: number; disruption: number };

function segmentCost(segment: RoutableSegment, hour: number, disruptions: RoutableDisruption[], now: Date): SegmentCost {
  // Segment congestion and time-of-day congestion are applied once each.
  const speed = Math.max(8, segment.baseSpeedKph * (LEVEL_FACTOR[segment.trafficLevel] ?? 0.86) * hourTrafficFactor(hour));
  const base = (segment.distanceMeters / 1000 / Math.max(8, segment.baseSpeedKph)) * 3600;
  const withTraffic = (segment.distanceMeters / 1000 / speed) * 3600;
  const total = withTraffic * segmentPenalty(segment, disruptions, now);
  return { total, base, traffic: Math.max(0, withTraffic - base), disruption: Math.max(0, total - withTraffic) };
}

function freeFlowSeconds(segment: RoutableSegment): number {
  return (segment.distanceMeters / 1000 / Math.max(8, segment.baseSpeedKph)) * 3600;
}

function connectorSeconds(meters: number): number {
  return (meters / 1000 / CONNECTOR_SPEED_KPH) * 3600;
}

type PathResult = { nodePath: string[]; segments: RoutableSegment[]; cost: number };

function shortestPath(
  graph: Graph,
  startId: string,
  endId: string,
  hour: number,
  disruptions: RoutableDisruption[],
  penaltyMap: Map<number, number>,
  now: Date,
): PathResult | null {
  if (!startId || !endId) return null;
  if (startId === endId) return { nodePath: [startId], segments: [], cost: 0 };
  const dist = new Map<string, number>([[startId, 0]]);
  const prev = new Map<string, { node: string; segment: RoutableSegment }>();
  const visited = new Set<string>();
  const queue: { node: string; cost: number }[] = [{ node: startId, cost: 0 }];

  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost);
    const current = queue.shift()!;
    if (visited.has(current.node)) continue;
    visited.add(current.node);
    if (current.node === endId) break;
    for (const edge of graph.adjacency.get(current.node) ?? []) {
      if (isBlocked(edge.segment, disruptions, now)) continue;
      const weight = segmentCost(edge.segment, hour, disruptions, now).total * (penaltyMap.get(edge.segment.id) ?? 1);
      const nextCost = current.cost + weight;
      if (nextCost < (dist.get(edge.other) ?? Number.POSITIVE_INFINITY)) {
        dist.set(edge.other, nextCost);
        prev.set(edge.other, { node: current.node, segment: edge.segment });
        queue.push({ node: edge.other, cost: nextCost });
      }
    }
  }

  if (!dist.has(endId)) return null;
  const nodePath: string[] = [endId];
  const segments: RoutableSegment[] = [];
  let cursor = endId;
  while (cursor !== startId) {
    const step = prev.get(cursor);
    if (!step) return null;
    segments.unshift(step.segment);
    nodePath.unshift(step.node);
    cursor = step.node;
  }
  return { nodePath, segments, cost: dist.get(endId) ?? 0 };
}

/** Insert intermediate vertices so the drawn path follows the road, not a chord. */
function densify(points: LatLng[], stepMeters = 22): LatLng[] {
  if (points.length < 2) return points;
  const out: LatLng[] = [points[0]];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const length = haversine(a, b);
    const steps = Math.max(1, Math.round(length / stepMeters));
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
    }
  }
  return out;
}

/** Chaikin corner cutting — rounds junctions so the vehicle sweeps through bends. */
function smoothPath(points: LatLng[], iterations = 2): LatLng[] {
  let current = points;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    if (current.length < 3) break;
    const next: LatLng[] = [current[0]];
    for (let i = 0; i < current.length - 1; i += 1) {
      const a = current[i];
      const b = current[i + 1];
      next.push({ lat: a.lat * 0.75 + b.lat * 0.25, lng: a.lng * 0.75 + b.lng * 0.25 });
      next.push({ lat: a.lat * 0.25 + b.lat * 0.75, lng: a.lng * 0.25 + b.lng * 0.75 });
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}

function dedupeCoords(points: LatLng[]): [number, number][] {
  const out: [number, number][] = [];
  for (const point of points) {
    const coord: [number, number] = [Number(point.lng.toFixed(6)), Number(point.lat.toFixed(6))];
    const last = out[out.length - 1];
    if (!last) {
      out.push(coord);
      continue;
    }
    // Skip sub-metre duplicates produced by corner smoothing.
    if (Math.abs(last[0] - coord[0]) < 0.000_012 && Math.abs(last[1] - coord[1]) < 0.000_012) continue;
    out.push(coord);
  }
  return out;
}

function buildOption(params: {
  label: string;
  points: LatLng[];
  segments: RoutableSegment[];
  costs: SegmentCost[];
  connectorSeconds: number;
  hour: number;
  disruptions: RoutableDisruption[];
  blockedCount: number;
  now: Date;
}): RouteOption {
  const { label, points, segments, costs, connectorSeconds, hour, disruptions, blockedCount, now } = params;
  const distanceMeters = polylineLength(points);
  const freeFlow = segments.reduce((sum, s) => sum + freeFlowSeconds(s), 0);
  const levels = segments.map((s) => currentTrafficLevel(s.trafficLevel, hour));
  const worst = levels.includes("severe")
    ? "severe"
    : levels.includes("heavy")
      ? "heavy"
      : levels.includes("moderate")
        ? "moderate"
        : "low";
  const onPath = disruptions.filter((d) => segments.some((s) => s.id === d.segmentId));
  const durationSeconds = costs.reduce((sum, cost) => sum + cost.total, 0) + connectorSeconds;

  const quality: RouteDataQuality = {
    verified: onPath.filter((d) => d.verification === "verified").length,
    community: onPath.filter((d) => d.verification === "community").length,
    unverified: onPath.filter((d) => !d.verification || d.verification === "unverified").length,
    lowConfidence: onPath.filter((d) => (d.confidence ?? 1) < 0.6).length,
    expired: onPath.filter((d) => isExpired(d, now)).length,
    averageConfidence:
      onPath.length > 0
        ? Number((onPath.reduce((sum, d) => sum + (d.confidence ?? 1), 0) / onPath.length).toFixed(2))
        : 1,
  };

  return {
    label,
    geometry: dedupeCoords(smoothPath(densify(points, 22), 2)),
    distanceMeters: Math.round(distanceMeters),
    durationSeconds: Math.round(durationSeconds),
    freeFlowSeconds: Math.round(freeFlow),
    delaySeconds: Math.round(Math.max(0, durationSeconds - freeFlow)),
    traffic: worst,
    roadNames: [...new Set(segments.map((s) => s.roadName))],
    disruptions: onPath.map((d) => ({
      id: d.id,
      title: d.title,
      type: d.type,
      severity: d.severity,
      roadName: segments.find((s) => s.id === d.segmentId)?.roadName ?? "",
      confidence: d.confidence ?? 1,
      verification: d.verification ?? "verified",
    })),
    blockedSegmentsAvoided: blockedCount,
    breakdown: {
      baseSeconds: Math.round(costs.reduce((sum, cost) => sum + cost.base, 0)),
      trafficSeconds: Math.round(costs.reduce((sum, cost) => sum + cost.traffic, 0)),
      disruptionSeconds: Math.round(costs.reduce((sum, cost) => sum + cost.disruption, 0)),
      connectorSeconds: Math.round(connectorSeconds),
    },
    dataQuality: quality,
  };
}

/**
 * Fastest-feasible route search.
 *
 * Edge weight = normal travel time + traffic delay + disruption penalty, where the
 * disruption penalty is scaled by the event's confidence, freshness, verification
 * status and direction of travel. Fully blocked edges are removed from the search.
 */
export function planRoute(params: {
  origin: LatLng;
  destination: LatLng;
  segments: RoutableSegment[];
  disruptions: RoutableDisruption[];
  alternatives?: number;
  now?: Date;
}): RoutePlan {
  const { origin, destination, segments, disruptions } = params;
  const now = params.now ?? new Date();
  const hour = now.getHours();
  const graph = buildGraph(segments);
  const startSnap = nearestEdgePoint(segments, origin);
  const endSnap = nearestEdgePoint(segments, destination);
  const blockedCount = segments.filter((s) => isBlocked(s, disruptions, now)).length;

  const emptyPlan: RoutePlan = {
    origin,
    destination,
    snappedOrigin: startSnap?.point ?? origin,
    snappedDestination: endSnap?.point ?? destination,
    options: [],
    fastest: null,
    generatedAt: now.toISOString(),
    networkSize: { nodes: graph.nodes.size, edges: segments.length },
  };

  if (!startSnap || !endSnap) return emptyPlan;

  const penaltyMap = new Map<number, number>();
  const options: RouteOption[] = [];
  const seen = new Set<string>();
  const maxAttempts = Math.max(1, Math.min(3, params.alternatives ?? 3));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let option: RouteOption | null = null;
    let usedSegments: RoutableSegment[] = [];
    const sameEdge = startSnap.segment.id === endSnap.segment.id;

    if (sameEdge) {
      const segment = startSnap.segment;
      const [first, second] = startSnap.alongMeters <= endSnap.alongMeters ? [startSnap, endSnap] : [endSnap, startSnap];
      const points: LatLng[] = [origin, first.point, second.point, destination];
      const middle = Math.abs(second.alongMeters - first.alongMeters);
      const cost = segmentCost(segment, hour, disruptions, now);
      const share = segment.distanceMeters > 0 ? middle / segment.distanceMeters : 1;
      const connectors = connectorSeconds(haversine(origin, first.point)) + connectorSeconds(haversine(second.point, destination));
      usedSegments = [segment];
      option = buildOption({
        label: attempt === 0 ? "Fastest route" : `Alternative ${attempt}`,
        points,
        segments: [segment],
        costs: [{ total: cost.total * share, base: cost.base * share, traffic: cost.traffic * share, disruption: cost.disruption * share }],
        connectorSeconds: connectors,
        hour,
        disruptions,
        blockedCount,
        now,
      });
    } else {
      const startNode = closerEndpoint(startSnap.segment, origin);
      const endNode = closerEndpoint(endSnap.segment, destination);
      const path = shortestPath(graph, startNode, endNode, hour, disruptions, penaltyMap, now);
      if (path) {
        const nodePoints = path.nodePath.map((id) => graph.nodes.get(id)).filter((p): p is LatLng => Boolean(p));
        const points: LatLng[] = [origin, startSnap.point, ...nodePoints, endSnap.point, destination];
        const traversed = [startSnap.segment, ...path.segments, endSnap.segment].filter(
          (segment, index, list) => list.findIndex((s) => s.id === segment.id) === index,
        );
        usedSegments = traversed;
        const connectors = connectorSeconds(haversine(origin, startSnap.point)) + connectorSeconds(haversine(endSnap.point, destination));
        option = buildOption({
          label: attempt === 0 ? "Fastest route" : `Alternative ${attempt}`,
          points,
          segments: traversed,
          costs: traversed.map((segment) => segmentCost(segment, hour, disruptions, now)),
          connectorSeconds: connectors,
          hour,
          disruptions,
          blockedCount,
          now,
        });
        if (option) {
          const signature = traversed.map((s) => s.id).join(",");
          if (seen.has(signature)) option = null;
          else seen.add(signature);
        }
      }
    }

    if (!option) break;
    options.push(option);
    for (const segment of usedSegments) penaltyMap.set(segment.id, (penaltyMap.get(segment.id) ?? 1) * 1.9);
  }

  options.sort((a, b) => a.durationSeconds - b.durationSeconds);
  options.forEach((option, index) => {
    option.label = index === 0 ? "Fastest route" : `Alternative ${index}`;
  });

  return {
    origin,
    destination,
    snappedOrigin: startSnap.point,
    snappedDestination: endSnap.point,
    options,
    fastest: options[0] ?? null,
    generatedAt: now.toISOString(),
    networkSize: { nodes: graph.nodes.size, edges: segments.length },
  };
}

export function routeLength(geometry: [number, number][]): number {
  return polylineLength(geometry.map(([lng, lat]) => ({ lat, lng })));
}
