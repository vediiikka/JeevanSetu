/**
 * Disruption-aware road routing.
 *
 * 1. Ask the OpenStreetMap routing service (OSRM, Valhalla failover) for the
 *    real road-following candidates, including alternatives.
 * 2. Score every candidate against live disruptions that lie on its road:
 *      - verified/community closures, waterlogging, damaged roads (high/critical)
 *        BLOCK the candidate,
 *      - everything else adds a penalty proportional to severity × confidence,
 *      - time-of-day congestion adds estimated delay.
 * 3. If the fastest road is blocked, request detours through points beside the
 *    blockage on OSM roads and keep any that avoid it.
 * 4. Return the fastest feasible road routes ranked by estimated travel time.
 *
 * If no routing service answers, the offline graph engine (routing.ts) is used so
 * the dispatch system keeps working; those options are labelled `engine: graph`.
 */
import { bearing, haversine, polylineLength, projectOnPolyline, type LatLng } from "@/lib/geo";
import { SEVERITY_MULTIPLIER, type DisruptionSeverity } from "@/lib/domain";
import {
  freshnessFactor,
  hourTrafficFactor,
  isBlocking,
  isExpired,
  planRoute,
  type RouteOption,
  type RoutePlan,
  type RoutableDisruption,
  type RoutableSegment,
} from "@/lib/routing";
import { fetchRoadCandidates, type RoadCandidate } from "@/lib/roadRouter";
import { planGraphRoutes } from "@/lib/graphRouting";

/** A disruption within this distance of the road is considered to affect it. */
const AFFECT_RADIUS_M = 120;
/** Detour offsets (metres) tried beside a blocking event, in order. */
const DETOUR_OFFSETS_M = [900, 1600];

type Evaluated = {
  candidate: RoadCandidate;
  base: number;
  traffic: number;
  penalty: number;
  effective: number;
  blocked: boolean;
  blockers: RoutableDisruption[];
  hits: { disruption: RoutableDisruption; distance: number; roadName: string }[];
  nearestNameFor: (point: LatLng) => string;
  points: LatLng[];
};

function toLatLng(geometry: [number, number][]): LatLng[] {
  return geometry.map(([lng, lat]) => ({ lat, lng }));
}

function nameAt(candidate: RoadCandidate, point: LatLng): string {
  let best = { name: "", distance: Number.POSITIVE_INFINITY };
  for (const step of candidate.steps) {
    if (!step.name || step.geometry.length < 2) continue;
    const distance = projectOnPolyline(point, toLatLng(step.geometry)).distanceMeters;
    if (distance < best.distance) best = { name: step.name, distance };
  }
  return best.name;
}

function evaluate(candidate: RoadCandidate, disruptions: RoutableDisruption[], hour: number, now: Date): Evaluated {
  const points = toLatLng(candidate.geometry);
  const base = candidate.durationSeconds;
  const congestion = 1 / hourTrafficFactor(hour) - 1;
  const traffic = base * Math.max(0, congestion) * 0.5;

  const blockers: RoutableDisruption[] = [];
  const hits: Evaluated["hits"] = [];
  let penalty = 0;

  for (const disruption of disruptions) {
    if (disruption.status !== "active" || isExpired(disruption, now)) continue;
    const distance = projectOnPolyline({ lat: disruption.lat, lng: disruption.lng }, points).distanceMeters;
    if (distance > AFFECT_RADIUS_M) continue;
    const roadName = nameAt(candidate, { lat: disruption.lat, lng: disruption.lng });
    hits.push({ disruption, distance, roadName });
    if (isBlocking(disruption, now)) {
      blockers.push(disruption);
      continue;
    }
    const multiplier = SEVERITY_MULTIPLIER[disruption.severity as DisruptionSeverity] ?? 1.3;
    const confidence = disruption.confidence ?? 1;
    penalty += base * (multiplier - 1) * confidence * freshnessFactor(disruption, now) * 0.35;
  }

  return {
    candidate,
    base,
    traffic,
    penalty,
    effective: base + traffic + penalty,
    blocked: blockers.length > 0,
    blockers,
    hits,
    nearestNameFor: (point) => nameAt(candidate, point),
    points,
  };
}

/** Point `meters` away from `center`, perpendicular to `headingDeg` (side = ±1). */
function offsetPerpendicular(center: LatLng, headingDeg: number, meters: number, side: 1 | -1): LatLng {
  const theta = ((headingDeg + 90 * side) * Math.PI) / 180;
  const dLat = (meters * Math.cos(theta)) / 111_320;
  const dLng = (meters * Math.sin(theta)) / (111_320 * Math.max(0.2, Math.cos((center.lat * Math.PI) / 180)));
  return { lat: center.lat + dLat, lng: center.lng + dLng };
}

/** Heading of the candidate road at the point closest to `target`. */
function headingNear(points: LatLng[], target: LatLng): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i += 1) {
    const distance = haversine(points[i], target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  const from = points[Math.max(0, bestIndex - 1)];
  const to = points[Math.min(points.length - 1, bestIndex + 1)];
  return bearing(from, to);
}

function trafficLabel(traffic: number, base: number): "low" | "moderate" | "heavy" | "severe" {
  const ratio = base > 0 ? traffic / base : 0;
  if (ratio < 0.1) return "low";
  if (ratio < 0.3) return "moderate";
  if (ratio < 0.5) return "heavy";
  return "severe";
}

function toOption(item: Evaluated, label: string, avoidedCount: number, now: Date): RouteOption {
  const { candidate } = item;
  const onRoad = item.hits;
  const cumulative: number[] = [];
  let running = 0;
  for (const step of candidate.steps) {
    cumulative.push(running);
    running += step.distanceMeters;
  }
  const quality = {
    verified: onRoad.filter((h) => h.disruption.verification === "verified").length,
    community: onRoad.filter((h) => h.disruption.verification === "community").length,
    unverified: onRoad.filter((h) => !h.disruption.verification || h.disruption.verification === "unverified").length,
    lowConfidence: onRoad.filter((h) => (h.disruption.confidence ?? 1) < 0.6).length,
    expired: onRoad.filter((h) => isExpired(h.disruption, now)).length,
    averageConfidence:
      onRoad.length > 0
        ? Number((onRoad.reduce((sum, h) => sum + (h.disruption.confidence ?? 1), 0) / onRoad.length).toFixed(2))
        : 1,
  };
  const roadNames = [...new Set(candidate.steps.map((s) => s.name).filter(Boolean))].slice(0, 12);
  if (roadNames.length === 0) roadNames.push("OSM road network");

  return {
    label,
    engine: candidate.engine,
    geometry: candidate.geometry,
    distanceMeters: Math.round(candidate.distanceMeters),
    durationSeconds: Math.round(item.effective),
    freeFlowSeconds: Math.round(item.base),
    delaySeconds: Math.round(Math.max(0, item.effective - item.base)),
    traffic: trafficLabel(item.traffic, item.base),
    roadNames,
    disruptions: onRoad.map((h) => ({
      id: h.disruption.id,
      title: h.disruption.title,
      type: h.disruption.type,
      severity: h.disruption.severity,
      roadName: h.roadName,
      confidence: h.disruption.confidence ?? 1,
      verification: h.disruption.verification ?? "verified",
    })),
    blockedSegmentsAvoided: avoidedCount,
    breakdown: {
      baseSeconds: Math.round(item.base),
      trafficSeconds: Math.round(item.traffic),
      disruptionSeconds: Math.round(item.penalty),
      connectorSeconds: 0,
    },
    dataQuality: quality,
    steps: candidate.steps.map((step, index) => ({
      name: step.name,
      instruction: step.instruction,
      distanceMeters: Math.round(step.distanceMeters),
      startMeters: Math.round(cumulative[index]),
      durationSeconds: Math.round(step.durationSeconds),
    })),
  };
}

function isNearDuplicate(a: RouteOption, b: RouteOption): boolean {
  const distanceClose = Math.abs(a.distanceMeters - b.distanceMeters) / Math.max(1, a.distanceMeters) < 0.03;
  const durationClose = Math.abs(a.durationSeconds - b.durationSeconds) / Math.max(1, a.durationSeconds) < 0.03;
  return distanceClose && durationClose;
}

export type RoadPlanParams = {
  origin: LatLng;
  destination: LatLng;
  disruptions: RoutableDisruption[];
  /** Offline graph used only when no routing service is reachable. */
  segments?: RoutableSegment[];
  alternatives?: number;
  now?: Date;
  withComparison?: boolean;
  simulated?: boolean;
};

/** Fastest feasible road routes between two points (road-following, disruption-aware). */
export async function planRoadRoute(params: RoadPlanParams): Promise<RoutePlan & { provider: string }> {
  const now = params.now ?? new Date();
  const maxOptions = Math.max(1, Math.min(3, params.alternatives ?? 3));

  // 1. OpenStreetMap road graph: A* and Dijkstra over real streets with traffic and disruptions.
  const graph = planGraphRoutes({
    origin: params.origin,
    destination: params.destination,
    disruptions: params.disruptions,
    now,
    alternatives: maxOptions,
    withComparison: params.withComparison,
    simulated: params.simulated,
  });
  if (graph && !graph.unreachable && graph.options.length > 0) {
    return { ...graph, provider: "osm-graph" };
  }

  // 2. Road-service alternatives (OSRM), used only outside the graph's coverage.
  const hour = now.getHours();
  const primary = await fetchRoadCandidates([params.origin, params.destination], true);

  if (primary.routes.length === 0) {
    // No routing service reachable — use the offline graph engine.
    const graph = planRoute({
      origin: params.origin,
      destination: params.destination,
      segments: params.segments ?? [],
      disruptions: params.disruptions,
      alternatives: maxOptions,
      now,
    });
    return { ...graph, options: graph.options.map((o) => ({ ...o, engine: "graph" })), provider: "graph-fallback" };
  }

  const evaluated = primary.routes.map((route) => evaluate(route, params.disruptions, hour, now));
  const totalBlockers = Math.max(0, ...evaluated.map((e) => e.blockers.length));
  let viable = evaluated.filter((e) => !e.blocked);

  // Fastest road is blocked: look for detours beside the blocking event(s).
  if (viable.length === 0) {
    const blockedRoute = evaluated[0];
    for (const blocker of blockedRoute.blockers.slice(0, 2)) {
      const center = { lat: blocker.lat, lng: blocker.lng };
      const heading = headingNear(blockedRoute.points, center);
      for (const offset of DETOUR_OFFSETS_M) {
        const via = [1, -1].map((side) => offsetPerpendicular(center, heading, offset, side as 1 | -1));
        for (const viaPoint of via) {
          const detour = await fetchRoadCandidates([params.origin, viaPoint, params.destination], false);
          for (const route of detour.routes) {
            const scored = evaluate(route, params.disruptions, hour, now);
            if (!scored.blocked) viable.push(scored);
          }
        }
        if (viable.length > 0) break;
      }
      if (viable.length > 0) break;
    }
  }

  viable.sort((a, b) => a.effective - b.effective);

  const options: RouteOption[] = [];
  for (const item of viable) {
    const option = toOption(item, "", totalBlockers, now);
    if (options.some((existing) => isNearDuplicate(existing, option))) continue;
    options.push(option);
    if (options.length >= maxOptions) break;
  }
  options.forEach((option, index) => {
    option.key = index === 0 ? "fastest" : `alt${index}`;
    option.label = index === 0 ? "Fastest route" : `Alternative ${index}`;
    option.algorithm = "OSRM road routing (Dijkstra-family contraction hierarchies)";
  });

  const start = options[0]?.geometry[0];
  const end = options[0]?.geometry[options[0].geometry.length - 1];
  return {
    origin: params.origin,
    destination: params.destination,
    snappedOrigin: start ? { lat: start[1], lng: start[0] } : params.origin,
    snappedDestination: end ? { lat: end[1], lng: end[0] } : params.destination,
    options,
    fastest: options[0] ?? null,
    generatedAt: now.toISOString(),
    networkSize: { nodes: 0, edges: 0 },
    provider: primary.provider,
  };
}

/** Total length of a route in metres (helper for callers that need it). */
export function routeMeters(geometry: [number, number][]): number {
  return polylineLength(toLatLng(geometry));
}
