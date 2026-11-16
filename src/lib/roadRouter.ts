/**
 * Real road-network routing through OpenStreetMap-based routing services.
 *
 * Primary:  OSRM (router.project-osrm.org)  — returns road-following geometry,
 *           road names and turn-by-turn steps for up to 3 alternatives.
 * Failover: Valhalla (valhalla1.openstreetmap.de) — same OSM road network,
 *           polyline6-encoded shapes.
 *
 * Results are cached in-process so that live polling (every few seconds) does
 * not re-query the public routing servers for the same origin/destination.
 * Callers receive `[]` when every provider is unreachable and must fall back to
 * the offline graph engine.
 */

export type LatLngPoint = { lat: number; lng: number };

export type RoadStep = {
  name: string;
  instruction: string;
  distanceMeters: number;
  durationSeconds: number;
  geometry: [number, number][]; // [lng, lat]
};

export type RoadCandidate = {
  engine: "osrm" | "valhalla";
  geometry: [number, number][]; // [lng, lat], follows the road network
  distanceMeters: number;
  durationSeconds: number; // free-flow OSM travel time
  steps: RoadStep[];
};

const OSRM_BASE = process.env.OSRM_BASE_URL?.trim() || "https://router.project-osrm.org";
const VALHALLA_BASE = process.env.VALHALLA_BASE_URL?.trim() || "https://valhalla1.openstreetmap.de";
const USER_AGENT = "JeevanSetu/1.0 (emergency routing; contact admin@jeevansetu.in)";
const TIMEOUT_MS = 9000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 600;

type CacheEntry = { at: number; value: RoadCandidate[] };
const cache = new Map<string, CacheEntry>();

function cacheKey(points: LatLngPoint[], alternatives: boolean): string {
  return `${alternatives ? "alt" : "single"}|${points
    .map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`)
    .join(";")}`;
}

function readCache(key: string): RoadCandidate[] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function writeCache(key: string, value: RoadCandidate[]): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

function instructionFor(type: string, modifier: string | undefined, name: string): string {
  const onto = name ? ` onto ${name}` : "";
  const side = modifier ? modifier : "";
  switch (type) {
    case "depart":
      return name ? `Head ${side || "out"} on ${name}`.replace(/\s+/g, " ") : "Start driving";
    case "arrive":
      return "Arrive at destination";
    case "turn":
      return `Turn ${side}${onto}`.replace(/\s+/g, " ").trim();
    case "new name":
    case "continue":
      return name ? `Continue on ${name}` : "Continue straight";
    case "merge":
      return `Merge${onto}`.trim();
    case "fork":
      return `Keep ${side}${onto}`.replace(/\s+/g, " ").trim();
    case "off ramp":
      return `Take the exit${onto}`.trim();
    case "roundabout":
    case "rotary":
      return `Enter the roundabout${onto}`.trim();
    case "end of road":
      return `Turn ${side}${onto}`.replace(/\s+/g, " ").trim();
    default:
      return name ? `Continue on ${name}` : "Continue";
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

type OsrmRoute = {
  distance: number;
  duration: number;
  geometry: { coordinates: [number, number][] };
  legs: {
    steps: {
      name: string;
      distance: number;
      duration: number;
      maneuver: { type: string; modifier?: string };
      geometry: { coordinates: [number, number][] };
    }[];
  }[];
};

/**
 * Insert points along each road segment so no two consecutive vertices are more
 * than `maxMeters` apart. Points are placed on the straight run between two OSM
 * vertices, so the shape of the road is unchanged; the vehicle simply gets a
 * finer sampling of the same road.
 */
function densifyLngLat(coords: [number, number][], maxMeters = 20): [number, number][] {
  if (coords.length < 2) return coords;
  const out: [number, number][] = [coords[0]];
  for (let i = 0; i < coords.length - 1; i += 1) {
    const [lng1, lat1] = coords[i];
    const [lng2, lat2] = coords[i + 1];
    const p1 = (lat1 * Math.PI) / 180;
    const p2 = (lat2 * Math.PI) / 180;
    const dp = p2 - p1;
    const dl = ((lng2 - lng1) * Math.PI) / 180;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    const meters = 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
    const steps = Math.max(1, Math.ceil(meters / maxMeters));
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      out.push([lng1 + (lng2 - lng1) * t, lat1 + (lat2 - lat1) * t]);
    }
  }
  return out;
}

async function queryOsrm(points: LatLngPoint[], alternatives: boolean): Promise<RoadCandidate[]> {
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  const url =
    `${OSRM_BASE}/route/v1/driving/${coords}` +
    `?overview=full&geometries=geojson&steps=true&continue_straight=false` +
    `&alternatives=${alternatives ? "3" : "false"}`;
  const data = (await fetchJson(url)) as { code: string; routes?: OsrmRoute[] };
  if (data.code !== "Ok" || !data.routes?.length) throw new Error(`OSRM ${data.code}`);

  return data.routes.map((route) => ({
    engine: "osrm" as const,
    geometry: densifyLngLat(route.geometry.coordinates),
    distanceMeters: route.distance,
    durationSeconds: route.duration,
    steps: (route.legs ?? []).flatMap((leg) =>
      leg.steps.map((step) => ({
        name: step.name || "",
        instruction: instructionFor(step.maneuver.type, step.maneuver.modifier, step.name || ""),
        distanceMeters: step.distance,
        durationSeconds: step.duration,
        geometry: step.geometry?.coordinates ?? [],
      })),
    ),
  }));
}

/** Decode a Valhalla polyline6 shape into [lng, lat] pairs. */
export function decodePolyline6(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of ["lat", "lng"] as const) {
      let shift = 0;
      let result = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === "lat") lat += delta;
      else lng += delta;
    }
    coords.push([lng / 1e6, lat / 1e6]);
  }
  return coords;
}

type ValhallaTrip = {
  summary: { length: number; time: number };
  legs: { shape: string; maneuvers: { type: number; instruction: string; street_names?: string[]; length: number; time: number; begin_shape_index: number; end_shape_index: number }[] }[];
};

async function queryValhalla(points: LatLngPoint[], alternatives: boolean): Promise<RoadCandidate[]> {
  const body = {
    locations: points.map((p) => ({ lat: p.lat, lon: p.lng })),
    costing: "auto",
    alternates: alternatives ? 2 : 0,
    directions_options: { units: "kilometers" },
  };
  const data = (await fetchJson(`${VALHALLA_BASE}/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as { trip?: ValhallaTrip; alternates?: { trip: ValhallaTrip }[] };
  const trips = [data.trip, ...(data.alternates ?? []).map((alt) => alt.trip)].filter(
    (trip): trip is ValhallaTrip => Boolean(trip),
  );
  if (trips.length === 0) throw new Error("Valhalla returned no trip");

  return trips.map((trip) => {
    const geometry = trip.legs.flatMap((leg) => decodePolyline6(leg.shape));
    const shape = trip.legs[0] ? decodePolyline6(trip.legs[0].shape) : geometry;
    const steps: RoadStep[] = (trip.legs[0]?.maneuvers ?? []).map((m) => ({
      name: m.street_names?.[0] ?? "",
      instruction: m.instruction,
      distanceMeters: m.length * 1000,
      durationSeconds: m.time,
      geometry: shape.slice(m.begin_shape_index, m.end_shape_index + 1),
    }));
    return {
      engine: "valhalla" as const,
      geometry,
      distanceMeters: trip.summary.length * 1000,
      durationSeconds: trip.summary.time,
      steps,
    };
  });
}

/**
 * Road-following candidate routes between the given points (origin, optional
 * via points, destination). Tries OSRM, then Valhalla. Returns [] if neither
 * service answers.
 */
export async function fetchRoadCandidates(
  points: LatLngPoint[],
  alternatives = true,
): Promise<{ routes: RoadCandidate[]; provider: string; error?: string }> {
  const key = cacheKey(points, alternatives);
  const cached = readCache(key);
  if (cached) return { routes: cached, provider: cached[0]?.engine ?? "cache" };

  const errors: string[] = [];
  try {
    const routes = await queryOsrm(points, alternatives);
    if (routes.length > 0) {
      writeCache(key, routes);
      return { routes, provider: "osrm" };
    }
  } catch (error) {
    errors.push(`OSRM: ${error instanceof Error ? error.message : "failed"}`);
  }

  try {
    const routes = await queryValhalla(points, alternatives);
    if (routes.length > 0) {
      writeCache(key, routes);
      return { routes, provider: "valhalla" };
    }
  } catch (error) {
    errors.push(`Valhalla: ${error instanceof Error ? error.message : "failed"}`);
  }

  return { routes: [], provider: "none", error: errors.join(" · ") };
}


export type RoadTable = {
  /** Road distance (m) per source, null when unreachable. */
  distances: (number | null)[];
  /** Road travel time (s) per source, null when unreachable. */
  durations: (number | null)[];
  provider: "osrm" | "none";
  error?: string;
};

/**
 * Road distance and travel time from every source to one destination in a single
 * OSRM table request. Used to rank ambulances by real road travel, not straight lines.
 */
export async function fetchRoadTable(sources: LatLngPoint[], destination: LatLngPoint): Promise<RoadTable> {
  const empty = sources.map(() => null);
  if (sources.length === 0) return { distances: [], durations: [], provider: "none" };
  const all = [...sources, destination];
  const coords = all.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  const sourceIndexes = sources.map((_, index) => index).join(";");
  const url =
    `${OSRM_BASE}/table/v1/driving/${coords}` +
    `?sources=${sourceIndexes}&destinations=${all.length - 1}&annotations=duration,distance`;
  try {
    const data = (await fetchJson(url)) as {
      code: string;
      durations?: (number | null)[][];
      distances?: (number | null)[][];
    };
    if (data.code !== "Ok" || !data.durations || !data.distances) throw new Error(`OSRM table ${data.code}`);
    return {
      durations: data.durations.map((row) => row[0] ?? null),
      distances: data.distances.map((row) => row[0] ?? null),
      provider: "osrm",
    };
  } catch (error) {
    return {
      durations: empty,
      distances: empty,
      provider: "none",
      error: error instanceof Error ? error.message : "road table unavailable",
    };
  }
}
