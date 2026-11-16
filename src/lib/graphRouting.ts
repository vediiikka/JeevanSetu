/**
 * Three ambulance route options on the OpenStreetMap road network.
 *
 *   1. Fastest          — A* with a Euclidean heuristic on traffic-aware travel time.
 *   2. Little fast      — Dijkstra with the fastest route's roads made 35–80% more expensive,
 *                         so it takes a different corridor that is only a little slower.
 *   3. Slow alternative — Dijkstra with the fastest and little-fast roads penalised harder,
 *                         giving a clearly different (longer or slower) corridor.
 *
 * Penalties only raise the search cost. Reported durations are always the true traffic-aware
 * times, so the three options are ranked honestly by what the ambulance would take.
 */
import { haversine, type LatLng } from "@/lib/geo";
import { shortestPath, type SearchResult } from "@/lib/pathfinding";
import {
  CONNECTOR_MPS,
  buildEdgeState,
  levelOf,
  loadRoadGraph,
  nearestNodes,
  searchGraph,
  type EdgeState,
  type Level,
  type RoadGraph,
} from "@/lib/roadGraph";
import type {
  RouteOption,
  RoutePlan,
  RouteStepView,
  RoutableDisruption,
  TrafficSegment,
} from "@/lib/routing";

export const OPTION_LABELS = {
  fastest: "Fastest",
  fast: "Little fast",
  slow: "Slow alternative",
} as const;

export type OptionKey = keyof typeof OPTION_LABELS;

export type Comparison = {
  euclideanKm: number;
  astar: { expanded: number; ms: number; costSeconds: number };
  dijkstra: { expanded: number; ms: number; costSeconds: number };
  sameOptimalTime: boolean;
};

export type GraphPlan = RoutePlan & {
  provider: "osm-graph";
  unreachable: boolean;
  comparison: Comparison | null;
  traffic: {
    hour: number;
    load: number;
    model: string;
    estimated: true;
    simulated: boolean;
  };
  graph: { source: string; license: string; generatedAt: string; junctions: number; segments: number };
};

export type GraphPlanParams = {
  origin: LatLng;
  destination: LatLng;
  disruptions: RoutableDisruption[];
  now?: Date;
  /** 1 = fastest only; 3 = fastest, little fast and slow alternative. */
  alternatives?: number;
  /** Also run Dijkstra on the fastest query and report both algorithms (diagnostic). */
  withComparison?: boolean;
  /** Set when the time of day is simulated for demonstration. */
  simulated?: boolean;
};

/** Ambulance-speed access roads: distance to the nearest junction is covered at this speed. */
const TERMINAL_RADIUS_M = 2500;
const CACHE_TTL_MS = 20_000;
const CACHE_LIMIT = 300;
const cache = new Map<string, { at: number; value: GraphPlan | null }>();

const round = (value: number, places: number) => Number(value.toFixed(places));

function disruptionSignature(disruptions: RoutableDisruption[]): string {
  return disruptions
    .map((d) => `${d.id}:${d.type}:${d.severity}:${d.confidence ?? 1}:${d.status}:${d.lat.toFixed(5)},${d.lng.toFixed(5)}`)
    .sort()
    .join("|");
}

function overlapShare(g: RoadGraph, steps: SearchResult["steps"], reference: Set<number>): number {
  let shared = 0;
  let total = 0;
  for (const step of steps) {
    const length = g.edgeLen[step.edge];
    total += length;
    if (reference.has(step.edge)) shared += length;
  }
  return total > 0 ? shared / total : 1;
}

function edgeCoords(g: RoadGraph, edge: number, dir: 0 | 1): [number, number][] {
  const from = dir === 0 ? g.edgeA[edge] : g.edgeB[edge];
  const to = dir === 0 ? g.edgeB[edge] : g.edgeA[edge];
  const coords: [number, number][] = [[g.nodeLng[from], g.nodeLat[from]]];
  const geom = g.edgeGeom[edge];
  if (dir === 0) {
    for (let k = 0; k < geom.length; k += 2) coords.push([geom[k], geom[k + 1]]);
  } else {
    for (let k = geom.length - 2; k >= 0; k -= 2) coords.push([geom[k], geom[k + 1]]);
  }
  coords.push([g.nodeLng[to], g.nodeLat[to]]);
  return coords;
}

function bearingDegrees(a: [number, number], b: [number, number]): number {
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function compassName(bearing: number): string {
  const names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  return names[Math.round(bearing / 45) % 8];
}

function turnInstruction(turn: number, name: string): string {
  const onto = name ? ` onto ${name}` : "";
  const abs = Math.abs(turn);
  const side = turn > 0 ? "right" : "left";
  if (abs < 20) return name ? `Continue on ${name}` : "Continue straight";
  if (abs < 60) return `Bear ${side}${onto}`;
  if (abs < 150) return `Turn ${side}${onto}`;
  return `Make a U-turn${onto}`;
}

/** Turn-by-turn guidance grouped by road name and by turns of more than about 35 degrees. */
function buildSteps(g: RoadGraph, state: EdgeState, steps: SearchResult["steps"], startOffsetMeters: number): RouteStepView[] {
  type Group = { name: string; start: number; meters: number; seconds: number; bearing: number; turn: number };
  const groups: Group[] = [];
  let cumulative = startOffsetMeters;
  let previousBearing: number | null = null;

  for (const step of steps) {
    const coords = edgeCoords(g, step.edge, step.dir);
    const bearing = bearingDegrees(coords[0], coords[coords.length - 1]);
    const name = g.names[g.edgeName[step.edge]] ?? "";
    const meters = g.edgeLen[step.edge];
    const seconds = Number.isFinite(state.timeSec[step.edge]) ? state.timeSec[step.edge] : 0;
    const turn =
      previousBearing === null ? 0 : ((((bearing - previousBearing) % 360) + 540) % 360) - 180;
    const current = groups[groups.length - 1];
    if (!current || name !== current.name || Math.abs(turn) > 35) {
      groups.push({ name, start: cumulative, meters, seconds, bearing, turn });
    } else {
      current.meters += meters;
      current.seconds += seconds;
    }
    cumulative += meters;
    previousBearing = bearing;
  }

  const result: RouteStepView[] = groups.map((group, index) => {
    const label = group.name || "the road";
    const instruction =
      index === 0
        ? `Head ${compassName(group.bearing)} on ${label}`
        : turnInstruction(group.turn, group.name);
    return {
      name: group.name,
      instruction,
      distanceMeters: Math.round(group.meters),
      startMeters: Math.round(group.start),
      durationSeconds: Math.round(group.seconds),
    };
  });
  result.push({ name: "", instruction: "Arrive at the destination", distanceMeters: 0, startMeters: Math.round(cumulative), durationSeconds: 0 });
  return result;
}

/** Traffic heatmap: consecutive road pieces with the same congestion level are merged. */
function buildSegments(g: RoadGraph, state: EdgeState, steps: SearchResult["steps"]): TrafficSegment[] {
  const segments: TrafficSegment[] = [];
  let current: TrafficSegment | null = null;
  for (const step of steps) {
    const level: Level = levelOf(state.congestion[step.edge]);
    const coords = edgeCoords(g, step.edge, step.dir);
    if (current && current.level === level) {
      current.points.push(...coords.slice(1));
    } else {
      current = { level, points: coords.slice() };
      segments.push(current);
    }
  }
  return segments;
}

function buildOption(params: {
  g: RoadGraph;
  state: EdgeState;
  result: SearchResult;
  key: OptionKey;
  algorithm: string;
  origin: LatLng;
  destination: LatLng;
  fastestEdges: Set<number>;
}): RouteOption {
  const { g, state, result, key, algorithm, origin, destination, fastestEdges } = params;
  const startLat = g.nodeLat[result.startNode];
  const startLng = g.nodeLng[result.startNode];
  const endLat = g.nodeLat[result.endNode];
  const endLng = g.nodeLng[result.endNode];
  const startConnectorM = haversine(origin, { lat: startLat, lng: startLng });
  const endConnectorM = haversine({ lat: endLat, lng: endLng }, destination);
  const connectorSeconds = (startConnectorM + endConnectorM) / CONNECTOR_MPS;

  // Geometry: origin → start junction → road geometry → end junction → destination.
  const geometry: [number, number][] = [[origin.lng, origin.lat], [startLng, startLat]];
  let roadMeters = 0;
  const mix: Record<Level, number> = { green: 0, orange: 0, red: 0 };
  let trafficSeconds = 0;
  let disruptionSeconds = 0;
  let freeFlowSeconds = 0;
  let weightedCongestion = 0;
  const roadNames: string[] = [];
  const seenNames = new Set<string>();
  const disruptionMap = new Map<number, RoutableDisruption & { edge: number }>();

  for (const step of result.steps) {
    const coords = edgeCoords(g, step.edge, step.dir);
    for (let k = 1; k < coords.length; k += 1) geometry.push(coords[k]);
    const length = g.edgeLen[step.edge];
    roadMeters += length;
    mix[levelOf(state.congestion[step.edge])] += length;
    const free = length / ((g.edgeKph[step.edge] / 3.6) * 1);
    freeFlowSeconds += free;
    const traffic = state.timeNoDisruption[step.edge] - free;
    trafficSeconds += Math.max(0, traffic);
    const withDisruption = state.timeSec[step.edge] - state.timeNoDisruption[step.edge];
    if (Number.isFinite(withDisruption)) disruptionSeconds += Math.max(0, withDisruption);
    weightedCongestion += state.congestion[step.edge] * length;
    const name = g.names[g.edgeName[step.edge]];
    if (name && !seenNames.has(name)) {
      seenNames.add(name);
      roadNames.push(name);
    }
    for (const d of state.affected.get(step.edge) ?? []) {
      if (!disruptionMap.has(d.id)) disruptionMap.set(d.id, { ...d, edge: step.edge });
    }
  }
  geometry.push([endLng, endLat], [destination.lng, destination.lat]);

  const dedupe: [number, number][] = [];
  for (const point of geometry) {
    const last = dedupe[dedupe.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) dedupe.push([round(point[0], 6), round(point[1], 6)]);
  }

  const durationSeconds = result.steps.reduce((sum, s) => sum + state.timeSec[s.edge], 0) + connectorSeconds;
  const freeTotal = freeFlowSeconds + connectorSeconds;
  const meanCongestion = roadMeters > 0 ? weightedCongestion / roadMeters : 0;
  const trafficLevel = meanCongestion < 0.3 ? "low" : meanCongestion < 0.55 ? "moderate" : meanCongestion < 0.8 ? "heavy" : "severe";

  const disruptions = [...disruptionMap.values()].map((d) => ({
    id: d.id,
    title: d.title,
    type: d.type,
    severity: d.severity,
    roadName: g.names[g.edgeName[d.edge]] ?? "",
    confidence: d.confidence ?? 1,
    verification: d.verification ?? "verified",
  }));

  const quality = {
    verified: disruptions.filter((d) => d.verification === "verified").length,
    community: disruptions.filter((d) => d.verification === "community").length,
    unverified: disruptions.filter((d) => !d.verification || d.verification === "unverified").length,
    lowConfidence: disruptions.filter((d) => d.confidence < 0.6).length,
    expired: 0,
    averageConfidence:
      disruptions.length > 0 ? round(disruptions.reduce((s, d) => s + d.confidence, 0) / disruptions.length, 2) : 1,
  };

  const mixTotal = mix.green + mix.orange + mix.red;
  const trafficMix =
    mixTotal > 0
      ? {
          green: Math.round((mix.green / mixTotal) * 100),
          orange: Math.round((mix.orange / mixTotal) * 100),
          red: Math.round((mix.red / mixTotal) * 100),
        }
      : { green: 100, orange: 0, red: 0 };
  const shared = overlapShare(g, result.steps, fastestEdges);
  return {
    label: OPTION_LABELS[key],
    key,
    engine: "osm-graph",
    algorithm,
    geometry: dedupe,
    distanceMeters: Math.round(roadMeters + startConnectorM + endConnectorM),
    durationSeconds: Math.round(durationSeconds),
    freeFlowSeconds: Math.round(freeTotal),
    delaySeconds: Math.round(Math.max(0, durationSeconds - freeTotal)),
    traffic: trafficLevel as RouteOption["traffic"],
    roadNames: roadNames.slice(0, 12).length ? roadNames.slice(0, 12) : ["OSM road network"],
    disruptions,
    blockedSegmentsAvoided: 0,
    breakdown: {
      baseSeconds: Math.round(freeFlowSeconds),
      trafficSeconds: Math.round(trafficSeconds),
      disruptionSeconds: Math.round(disruptionSeconds),
      connectorSeconds: Math.round(connectorSeconds),
    },
    dataQuality: quality,
    trafficMix,
    steps: buildSteps(g, state, result.steps, startConnectorM),
    segments: buildSegments(g, state, result.steps),
    overlapWithFastest: round(shared, 3),
    distinct: key === "fastest" ? true : shared < 0.98,
    nodesExpanded: result.expanded,
    computeMs: round(result.ms, 2),
  };
}

/** Three road route options from origin to destination, or null when the graph does not cover the trip. */
export function planGraphRoutes(params: GraphPlanParams): GraphPlan | null {
  const g = loadRoadGraph();
  if (!g) return null;
  const now = params.now ?? new Date();
  const wanted = Math.max(1, Math.min(3, params.alternatives ?? 3));
  const cacheKey = params.withComparison
    ? null
    : [
        round(params.origin.lat, 4),
        round(params.origin.lng, 4),
        round(params.destination.lat, 4),
        round(params.destination.lng, 4),
        Math.floor(now.getTime() / 60_000),
        wanted,
        params.simulated ? "sim" : "live",
        disruptionSignature(params.disruptions),
      ].join("|");
  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  }

  const plan = computePlan(g, params, now, wanted);
  if (cacheKey) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    cache.set(cacheKey, { at: Date.now(), value: plan });
  }
  return plan;
}

function computePlan(g: RoadGraph, params: GraphPlanParams, now: Date, wanted: number): GraphPlan | null {
  const { origin, destination } = params;
  const originHits = nearestNodes(g, origin.lng, origin.lat, 4, TERMINAL_RADIUS_M);
  const destinationHits = nearestNodes(g, destination.lng, destination.lat, 4, TERMINAL_RADIUS_M);
  if (originHits.length === 0 || destinationHits.length === 0) return null;

  const state = buildEdgeState(g, now, params.disruptions, [origin, destination]);
  const search = searchGraph(g);
  const sources = originHits.map((h) => ({ node: h.node, cost: h.meters / CONNECTOR_MPS }));
  const targets = destinationHits.map((h) => ({ node: h.node, cost: h.meters / CONNECTOR_MPS }));
  const goal = { lng: destination.lng, lat: destination.lat };

  const fastest = shortestPath(search, state.timeSec, sources, targets, "astar", goal);
  const trafficInfo = {
    hour: state.hour,
    load: state.load,
    model: "time of day × road class × signalised junctions + reported disruptions",
    estimated: true as const,
    simulated: Boolean(params.simulated),
  };
  const graphInfo = {
    source: g.source,
    license: g.license,
    generatedAt: g.generatedAt,
    junctions: g.nodeCount,
    segments: g.edgeCount,
  };
  const emptyPlan = (unreachable: boolean): GraphPlan => ({
    origin,
    destination,
    snappedOrigin: origin,
    snappedDestination: destination,
    options: [],
    fastest: null,
    generatedAt: now.toISOString(),
    networkSize: { nodes: g.nodeCount, edges: g.edgeCount },
    provider: "osm-graph",
    unreachable,
    comparison: null,
    traffic: trafficInfo,
    graph: graphInfo,
  });

  if (!fastest.found) return emptyPlan(true);

  const fastestEdges = new Set(fastest.steps.map((s) => s.edge));
  const candidates: { result: SearchResult; key: OptionKey; algorithm: string }[] = [
    { result: fastest, key: "fastest", algorithm: "A* (Euclidean heuristic, traffic-aware time)" },
  ];

  let comparison: Comparison | null = null;
  if (params.withComparison) {
    const dijkstra = shortestPath(search, state.timeSec, sources, targets, "dijkstra", null);
    comparison = {
      euclideanKm: round(haversine(origin, destination) / 1000, 2),
      astar: { expanded: fastest.expanded, ms: round(fastest.ms, 2), costSeconds: round(fastest.cost, 1) },
      dijkstra: { expanded: dijkstra.expanded, ms: round(dijkstra.ms, 2), costSeconds: round(dijkstra.cost, 1) },
      sameOptimalTime: Math.abs(dijkstra.cost - fastest.cost) < 0.5,
    };
  }

  if (wanted >= 2) {
    // Little fast: penalise the fastest route's roads by 35%, then 80%, then 160%.
    const little = penalisedSearch(g, state, search, sources, targets, [0.35, 0.8, 1.6], fastestEdges, (steps) => {
      return overlapShare(g, steps, fastestEdges) <= 0.9;
    });
    if (little && overlapShare(g, little.steps, fastestEdges) < 0.98) {
      candidates.push({ result: little, key: "fast", algorithm: "Dijkstra (fastest roads penalised 35–160%)" });
    }
  }
  if (wanted >= 3) {
    // Slow alternative: penalise both earlier routes harder, requiring a clearly different corridor.
    const earlier = new Set<number>(fastestEdges);
    for (const c of candidates) for (const s of c.result.steps) earlier.add(s.edge);
    const slow = penalisedSearch(g, state, search, sources, targets, [1.2, 3, 6], earlier, (steps) => {
      const other = candidates.map((c) => overlapShare(g, steps, new Set(c.result.steps.map((s) => s.edge))));
      return other.every((share) => share <= 0.75);
    });
    const slowDistinct = slow && candidates.every((c) => overlapShare(g, slow.steps, new Set(c.result.steps.map((s) => s.edge))) < 0.98);
    if (slow && slowDistinct) {
      candidates.push({ result: slow, key: "slow", algorithm: "Dijkstra (earlier corridors penalised 120–600%)" });
    }
  }

  const built = candidates.map((c) =>
    buildOption({
      g,
      state,
      result: c.result,
      key: c.key,
      algorithm: c.algorithm,
      origin,
      destination,
      fastestEdges,
    }),
  );

  // Rank by true traffic-aware time, then give the three slots their names in that order.
  built.sort((a, b) => a.durationSeconds - b.durationSeconds);
  const names: OptionKey[] = ["fastest", "fast", "slow"];
  const options = built.map((option, index) => {
    const key = names[index];
    return { ...option, key, label: OPTION_LABELS[key] };
  });

  const start = options[0].geometry[0];
  const end = options[0].geometry[options[0].geometry.length - 1];
  return {
    origin,
    destination,
    snappedOrigin: { lat: start[1], lng: start[0] },
    snappedDestination: { lat: end[1], lng: end[0] },
    options,
    fastest: options[0],
    generatedAt: now.toISOString(),
    networkSize: { nodes: g.nodeCount, edges: g.edgeCount },
    provider: "osm-graph",
    unreachable: false,
    comparison,
    traffic: trafficInfo,
    graph: graphInfo,
  };
}

/** Dijkstra with penalised roads. Tries increasing penalties until `accept` is satisfied. */
function penalisedSearch(
  g: RoadGraph,
  state: EdgeState,
  search: ReturnType<typeof searchGraph>,
  sources: { node: number; cost: number }[],
  targets: { node: number; cost: number }[],
  penalties: number[],
  penalised: Set<number>,
  accept: (steps: SearchResult["steps"]) => boolean,
): SearchResult | null {
  let fallback: { result: SearchResult; share: number } | null = null;
  for (const penalty of penalties) {
    const times = Float64Array.from(state.timeSec);
    for (const edge of penalised) {
      if (Number.isFinite(times[edge])) times[edge] *= 1 + penalty;
    }
    const result = shortestPath(search, times, sources, targets, "dijkstra", null);
    if (!result.found) continue;
    if (accept(result.steps)) return result;
    const share = overlapShare(g, result.steps, penalised);
    if (!fallback || share < fallback.share) fallback = { result, share };
  }
  return fallback?.result ?? null;
}

export function isOptionKey(value: unknown): value is OptionKey {
  return value === "fastest" || value === "fast" || value === "slow";
}
