/**
 * Road network in memory: loads the OpenStreetMap graph built by scripts/build-road-graph.mjs,
 * indexes it spatially, and computes per-edge travel time and traffic congestion.
 *
 * Server-only. The graph file is read from data/road-graph/ when first needed, so routing
 * never depends on an external routing service while the application is running.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { freshnessFactor, isBlocking, isExpired, type RoutableDisruption } from "@/lib/routing";
import type { SearchGraph } from "@/lib/pathfinding";

export const GRAPH_FILE = "data/road-graph/gujarat-osm.json.gz";
export const MAX_SPEED_KPH = 90;
/** Access speed from a patient or ambulance position to the nearest junction (22 km/h). */
export const CONNECTOR_MPS = 22 / 3.6;

const CELL_DEG = 0.004; // ~440 m grid cells for the spatial indexes

/** Typical free-flow speeds (km/h) per OSM road class, used when a way has no maxspeed tag. */
const CLASS_KPH: Record<string, number> = {
  motorway: 90,
  trunk: 70,
  primary: 50,
  secondary: 40,
  tertiary: 35,
  unclassified: 30,
  residential: 25,
  motorway_link: 50,
  trunk_link: 45,
  primary_link: 35,
  secondary_link: 30,
  tertiary_link: 28,
};

/**
 * How strongly the time-of-day load affects each road class. Arterials congest most, residential
 * streets least. Values are modelling assumptions, not measurements.
 */
const CLASS_SENSITIVITY: Record<string, number> = {
  motorway: 0.45,
  trunk: 0.9,
  primary: 1.0,
  secondary: 0.9,
  tertiary: 0.75,
  unclassified: 0.5,
  residential: 0.45,
  motorway_link: 0.6,
  trunk_link: 0.8,
  primary_link: 0.9,
  secondary_link: 0.8,
  tertiary_link: 0.7,
};

/** Minimum congestion index on roads affected by a reported incident, by severity. */
const INCIDENT_CONGESTION: Record<string, number> = {
  low: 0.32,
  moderate: 0.45,
  high: 0.62,
  critical: 0.8,
};

/**
 * Share of peak congestion by hour of day (Asia/Kolkata). Morning and evening peaks match
 * typical urban commuting; night hours are close to free-flow.
 */
const LOAD_BY_HOUR = [
  0.05, 0.04, 0.03, 0.03, 0.05, 0.12, 0.4, 0.6, 0.7, 0.75, 0.72, 0.66, 0.55, 0.5, 0.52, 0.55, 0.62, 0.85,
  0.9, 0.85, 0.7, 0.5, 0.3, 0.12,
];

type RawGraph = {
  format: string;
  generatedAt: string;
  source: string;
  license: string;
  bbox: { south: number; west: number; north: number; east: number };
  classes: string[];
  names: string[];
  nodes: [number, number][];
  edges: [number, number, number, number, number, number, number, number[]][];
};

export type RoadGraph = SearchGraph & {
  source: string;
  license: string;
  generatedAt: string;
  edgeCount: number;
  edgeLen: Float32Array; // metres
  edgeCls: Uint8Array;
  edgeKph: Float32Array;
  edgeOneway: Int8Array;
  edgeName: Int32Array;
  edgeGeom: number[][]; // interior points, flat [lng, lat, lng, lat, ...]
  classes: string[];
  names: string[];
  degree: Uint8Array;
  minLng: number;
  minLat: number;
  nodeCells: Map<number, number[]>;
  edgeCells: Map<number, number[]>;
};

export type NodeHit = { node: number; meters: number };
export type EdgeHit = { edge: number; meters: number };
export type Level = "green" | "orange" | "red";

export type EdgeState = {
  hour: number;
  load: number;
  /** Congestion index 0..0.95 per edge (time-of-day model plus reported disruptions). */
  congestion: Float32Array;
  /** Travel time in seconds without disruption penalties (traffic model only). */
  timeNoDisruption: Float64Array;
  /** Travel time in seconds including disruptions; Infinity when the edge is closed. */
  timeSec: Float64Array;
  blocked: Uint8Array;
  affected: Map<number, RoutableDisruption[]>;
};

/**
 * One road network per server process, shared by every route bundle. Next.js compiles each route
 * into its own module copy, so a plain module variable would load the network once per route.
 */
const sharedGraph = globalThis as typeof globalThis & {
  __jeevansetuRoadGraph?: { graph: RoadGraph | null; error: string | null };
};
function shared(): { graph: RoadGraph | null; error: string | null } {
  if (!sharedGraph.__jeevansetuRoadGraph) sharedGraph.__jeevansetuRoadGraph = { graph: null, error: null };
  return sharedGraph.__jeevansetuRoadGraph;
}

/** Where the road network is looked for, in order. JEEVANSETU_ROAD_GRAPH overrides the default. */
export function roadGraphCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.JEEVANSETU_ROAD_GRAPH?.trim()) candidates.push(path.resolve(process.env.JEEVANSETU_ROAD_GRAPH.trim()));
  candidates.push(path.resolve(process.cwd(), GRAPH_FILE));
  return candidates;
}

/** The road network file that exists on this computer, or null. */
export function roadGraphFile(): string | null {
  return roadGraphCandidates().find((file) => existsSync(file)) ?? null;
}

/**
 * Loads and indexes the road graph. A missing file is NOT cached: the server re-checks on the
 * next request, so a network rebuilt in the background is picked up without a restart.
 */
export function loadRoadGraph(): RoadGraph | null {
  const store = shared();
  if (store.graph) return store.graph;
  const file = roadGraphFile();
  if (!file) {
    store.error = `road network file not found (looked in: ${roadGraphCandidates().join(", ")})`;
    return null;
  }
  try {
    const raw = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as RawGraph;
    store.graph = buildGraph(raw);
    store.error = null;
    return store.graph;
  } catch (error) {
    store.error = `road network file could not be read: ${error instanceof Error ? error.message : String(error)}`;
    return null;
  }
}

/** Forget the loaded network so the next call reads the file again (used after a rebuild). */
export function resetRoadGraphCache(): void {
  const store = shared();
  store.graph = null;
  store.error = null;
}

export type RoadGraphStatus = {
  loaded: boolean;
  file: string | null;
  junctions: number;
  segments: number;
  error: string | null;
  fix: string;
};

export function roadGraphStatus(): RoadGraphStatus {
  const store = shared();
  return {
    loaded: store.graph !== null,
    file: roadGraphFile(),
    junctions: store.graph?.nodeCount ?? 0,
    segments: store.graph?.edgeCount ?? 0,
    error: store.graph ? null : store.error,
    fix: "Run `node scripts/build-road-graph.mjs` (needs internet), or copy data/road-graph/gujarat-osm.json.gz into the project, then restart.",
  };
}

function cellX(lng: number, minLng: number): number {
  return Math.floor((lng - minLng) / CELL_DEG);
}
function cellY(lat: number, minLat: number): number {
  return Math.floor((lat - minLat) / CELL_DEG);
}
function cellKey(cx: number, cy: number): number {
  return (cx + 5000) * 100_000 + (cy + 5000);
}
function pushCell(map: Map<number, number[]>, key: number, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function buildGraph(raw: RawGraph): RoadGraph {
  const nodeCount = raw.nodes.length;
  const edgeCount = raw.edges.length;
  const nodeLng = new Float64Array(nodeCount);
  const nodeLat = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i += 1) {
    nodeLng[i] = raw.nodes[i][0];
    nodeLat[i] = raw.nodes[i][1];
  }

  const edgeA = new Int32Array(edgeCount);
  const edgeB = new Int32Array(edgeCount);
  const edgeLen = new Float32Array(edgeCount);
  const edgeCls = new Uint8Array(edgeCount);
  const edgeKph = new Float32Array(edgeCount);
  const edgeOneway = new Int8Array(edgeCount);
  const edgeName = new Int32Array(edgeCount);
  const edgeGeom: number[][] = new Array(edgeCount);
  const degree = new Uint8Array(nodeCount);

  for (let e = 0; e < edgeCount; e += 1) {
    const [a, b, length, cls, oneway, name, maxspeed, geom] = raw.edges[e];
    edgeA[e] = a;
    edgeB[e] = b;
    edgeLen[e] = length;
    edgeCls[e] = cls;
    edgeOneway[e] = oneway;
    edgeName[e] = name;
    edgeGeom[e] = geom;
    const className = raw.classes[cls] ?? "unclassified";
    const kph = maxspeed > 0 ? Math.max(15, Math.min(MAX_SPEED_KPH, maxspeed)) : (CLASS_KPH[className] ?? 30);
    edgeKph[e] = Math.min(MAX_SPEED_KPH, kph);
    degree[a] += 1;
    degree[b] += 1;
  }

  // Compressed adjacency lists: forward edges from A (unless one-way B→A) and reverse from B.
  const outStart = new Int32Array(nodeCount + 1);
  for (let e = 0; e < edgeCount; e += 1) {
    if (edgeOneway[e] !== -1) outStart[edgeA[e] + 1] += 1;
    if (edgeOneway[e] !== 1) outStart[edgeB[e] + 1] += 1;
  }
  for (let i = 0; i < nodeCount; i += 1) outStart[i + 1] += outStart[i];
  const outTotal = outStart[nodeCount];
  const outEdge = new Int32Array(outTotal);
  const outDir = new Uint8Array(outTotal);
  const cursor = Int32Array.from(outStart.subarray(0, nodeCount));
  for (let e = 0; e < edgeCount; e += 1) {
    if (edgeOneway[e] !== -1) {
      const slot = cursor[edgeA[e]]++;
      outEdge[slot] = e;
      outDir[slot] = 0;
    }
    if (edgeOneway[e] !== 1) {
      const slot = cursor[edgeB[e]]++;
      outEdge[slot] = e;
      outDir[slot] = 1;
    }
  }

  const minLng = raw.bbox.west;
  const minLat = raw.bbox.south;
  const nodeCells = new Map<number, number[]>();
  for (let n = 0; n < nodeCount; n += 1) {
    pushCell(nodeCells, cellKey(cellX(nodeLng[n], minLng), cellY(nodeLat[n], minLat)), n);
  }

  const edgeCells = new Map<number, number[]>();
  for (let e = 0; e < edgeCount; e += 1) {
    const geom = edgeGeom[e];
    let west = Math.min(nodeLng[edgeA[e]], nodeLng[edgeB[e]]);
    let east = Math.max(nodeLng[edgeA[e]], nodeLng[edgeB[e]]);
    let south = Math.min(nodeLat[edgeA[e]], nodeLat[edgeB[e]]);
    let north = Math.max(nodeLat[edgeA[e]], nodeLat[edgeB[e]]);
    for (let k = 0; k < geom.length; k += 2) {
      west = Math.min(west, geom[k]);
      east = Math.max(east, geom[k]);
      south = Math.min(south, geom[k + 1]);
      north = Math.max(north, geom[k + 1]);
    }
    for (let cx = cellX(west, minLng); cx <= cellX(east, minLng); cx += 1) {
      for (let cy = cellY(south, minLat); cy <= cellY(north, minLat); cy += 1) {
        pushCell(edgeCells, cellKey(cx, cy), e);
      }
    }
  }

  return {
    source: raw.source,
    license: raw.license,
    generatedAt: raw.generatedAt,
    nodeCount,
    edgeCount,
    nodeLng,
    nodeLat,
    edgeA,
    edgeB,
    edgeLen,
    edgeCls,
    edgeKph,
    edgeOneway,
    edgeName,
    edgeGeom,
    outStart,
    outEdge,
    outDir,
    classes: raw.classes,
    names: raw.names,
    degree,
    minLng,
    minLat,
    nodeCells,
    edgeCells,
  };
}

/** Euclidean distance in metres on the local plane (accurate to well under 1% across a city). */
export function planarMeters(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const cosLat = Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const dx = (lng2 - lng1) * 111_320 * cosLat;
  const dy = (lat2 - lat1) * 110_574;
  return Math.sqrt(dx * dx + dy * dy);
}

/** The k junctions closest to a point (Euclidean), within maxMeters. */
export function nearestNodes(g: RoadGraph, lng: number, lat: number, k = 4, maxMeters = 2500): NodeHit[] {
  const cx = cellX(lng, g.minLng);
  const cy = cellY(lat, g.minLat);
  const maxRing = Math.ceil(maxMeters / (CELL_DEG * 110_000)) + 1;
  const hits: NodeHit[] = [];
  const cosLat = Math.cos((lat * Math.PI) / 180);
  for (let r = 0; r <= maxRing; r += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const list = g.nodeCells.get(cellKey(cx + dx, cy + dy));
        if (!list) continue;
        for (const node of list) {
          const meters = planarMeters(lng, lat, g.nodeLng[node], g.nodeLat[node]);
          if (meters <= maxMeters) hits.push({ node, meters });
        }
      }
    }
    hits.sort((a, b) => a.meters - b.meters);
    if (hits.length > k) hits.length = k;
    // Every junction not yet visited lies at least r cells away.
    const reachedBound = r * CELL_DEG * 110_000 * cosLat;
    if (hits.length >= k && hits[k - 1].meters <= reachedBound) break;
  }
  return hits.slice(0, k);
}

function pointSegmentMeters(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}

/** Distance (metres) from a point to the drawn centre line of an edge. */
export function distanceToEdgeMeters(g: RoadGraph, edge: number, lng: number, lat: number): number {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const kx = 111_320 * cosLat;
  const ky = 110_574;
  const geom = g.edgeGeom[edge];
  const a = g.edgeA[edge];
  const b = g.edgeB[edge];
  let best = Number.POSITIVE_INFINITY;
  let prevX = (g.nodeLng[a] - lng) * kx;
  let prevY = (g.nodeLat[a] - lat) * ky;
  for (let k = 0; k < geom.length; k += 2) {
    const x = (geom[k] - lng) * kx;
    const y = (geom[k + 1] - lat) * ky;
    best = Math.min(best, pointSegmentMeters(0, 0, prevX, prevY, x, y));
    prevX = x;
    prevY = y;
  }
  const endX = (g.nodeLng[b] - lng) * kx;
  const endY = (g.nodeLat[b] - lat) * ky;
  best = Math.min(best, pointSegmentMeters(0, 0, prevX, prevY, endX, endY));
  return best;
}

/** Edges whose centre line lies within radiusMeters of a point. */
export function edgesNear(g: RoadGraph, lng: number, lat: number, radiusMeters: number): EdgeHit[] {
  const cx = cellX(lng, g.minLng);
  const cy = cellY(lat, g.minLat);
  const span = Math.ceil(radiusMeters / (CELL_DEG * 110_000)) + 1;
  const seen = new Set<number>();
  const hits: EdgeHit[] = [];
  for (let dx = -span; dx <= span; dx += 1) {
    for (let dy = -span; dy <= span; dy += 1) {
      const list = g.edgeCells.get(cellKey(cx + dx, cy + dy));
      if (!list) continue;
      for (const edge of list) {
        if (seen.has(edge)) continue;
        seen.add(edge);
        const meters = distanceToEdgeMeters(g, edge, lng, lat);
        if (meters <= radiusMeters) hits.push({ edge, meters });
      }
    }
  }
  return hits;
}

/** Hour of day in India Standard Time (the operating region). */
export function localHour(now: Date): number {
  const part = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(now)
    .find((p) => p.type === "hour");
  return part ? Number(part.value) % 24 : now.getUTCHours();
}

export function trafficLoad(hour: number): number {
  return LOAD_BY_HOUR[hour % 24] ?? 0.5;
}

/** Speed multiplier for a congestion index: 1 when free-flowing, down to 25% when gridlocked. */
export function speedFactor(congestion: number): number {
  return Math.max(0.25, 1 - 0.75 * congestion);
}

export function levelOf(congestion: number): Level {
  if (congestion < 0.3) return "green";
  if (congestion < 0.55) return "orange";
  return "red";
}

/** Free-flow travel time in seconds for an edge. */
export function freeFlowSeconds(g: RoadGraph, edge: number): number {
  return g.edgeLen[edge] / ((g.edgeKph[edge] / 3.6) * 1);
}

/**
 * Traffic state for every edge at a given time, including reported disruptions.
 *
 * Congestion = time-of-day load x road-class sensitivity (+ a signalised-junction term where
 * three or more roads meet). Active disruptions within 120 m of an edge add a penalty scaled by
 * severity and confidence; closures and verified severe obstructions block the edge.
 */
export function buildEdgeState(
  g: RoadGraph,
  now: Date,
  disruptions: RoutableDisruption[],
  /** Trip endpoints: roads within 200 m of these stay open (heavily congested) so the patient is always reachable. */
  endpoints: { lat: number; lng: number }[] = [],
): EdgeState {
  const hour = localHour(now);
  const load = trafficLoad(hour);
  const congestion = new Float32Array(g.edgeCount);
  const timeNoDisruption = new Float64Array(g.edgeCount);
  const timeSec = new Float64Array(g.edgeCount);
  const blocked = new Uint8Array(g.edgeCount);
  const affected = new Map<number, RoutableDisruption[]>();

  for (let e = 0; e < g.edgeCount; e += 1) {
    const className = g.classes[g.edgeCls[e]] ?? "unclassified";
    const sensitivity = CLASS_SENSITIVITY[className] ?? 0.7;
    const junction = g.degree[g.edgeA[e]] >= 3 || g.degree[g.edgeB[e]] >= 3 ? 0.08 : 0;
    const c = Math.min(0.9, load * sensitivity * 0.75 + junction * sensitivity);
    congestion[e] = c;
    timeNoDisruption[e] = g.edgeLen[e] / ((g.edgeKph[e] / 3.6) * speedFactor(c));
  }

  for (const d of disruptions) {
    if (d.status !== "active" || isExpired(d, now)) continue;
    const hits = edgesNear(g, d.lng, d.lat, 120);
    const closes = isBlocking(d, now);
    // Severity sets the least congestion an affected road can have; confidence and freshness scale it.
    const floor = Math.min(
      0.95,
      (INCIDENT_CONGESTION[d.severity] ?? 0.45) * (0.6 + 0.4 * (d.confidence ?? 1)) * freshnessFactor(d, now),
    );
    for (const { edge } of hits) {
      const list = affected.get(edge);
      if (list) list.push(d);
      else affected.set(edge, [d]);
      if (closes) blocked[edge] = 1;
      else congestion[edge] = Math.max(congestion[edge], floor);
    }
  }

  // A closure or flood on the road where the patient or the hospital is must not make them
  // unreachable. Those roads stay open but are treated as heavily congested.
  for (const point of endpoints) {
    for (const { edge } of edgesNear(g, point.lng, point.lat, 200)) {
      if (blocked[edge]) {
        blocked[edge] = 0;
        congestion[edge] = Math.max(congestion[edge], 0.95);
      }
    }
  }

  for (let e = 0; e < g.edgeCount; e += 1) {
    if (blocked[e]) {
      timeSec[e] = Number.POSITIVE_INFINITY;
      continue;
    }
    const speed = (g.edgeKph[e] / 3.6) * speedFactor(congestion[e]);
    timeSec[e] = g.edgeLen[e] / speed;
  }

  return { hour, load, congestion, timeNoDisruption, timeSec, blocked, affected };
}

/** Graph view used by the search functions. */
export function searchGraph(g: RoadGraph): SearchGraph {
  return {
    nodeCount: g.nodeCount,
    nodeLng: g.nodeLng,
    nodeLat: g.nodeLat,
    edgeA: g.edgeA,
    edgeB: g.edgeB,
    outStart: g.outStart,
    outEdge: g.outEdge,
    outDir: g.outDir,
  };
}
