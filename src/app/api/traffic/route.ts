import { ok, requireLat, requireLng, route } from "@/lib/api";
import { loadDisruptions } from "@/lib/dispatch";
import { buildEdgeState, edgesNear, levelOf, loadRoadGraph } from "@/lib/roadGraph";

export const dynamic = "force-dynamic";

const MAX_EDGES = 4000;

/**
 * Traffic heatmap for an area: every road segment within the radius with its congestion level
 * (green / orange / red). Estimated from the time-of-day model and reported disruptions — it is
 * not live sensor data. Optional `at` (ISO time) simulates a time of day.
 */
export const GET = route(async (request: Request) => {
  const url = new URL(request.url);
  const lat = requireLat(url.searchParams.get("lat"), "latitude");
  const lng = requireLng(url.searchParams.get("lng"), "longitude");
  const radius = Math.max(300, Math.min(6000, Number(url.searchParams.get("radius") ?? 2500) || 2500));
  const at = url.searchParams.get("at");
  const now = at && !Number.isNaN(Date.parse(at)) ? new Date(at) : new Date();

  const g = loadRoadGraph();
  if (!g) return ok({ available: false, reason: "Road network file is not installed", edges: [] });

  const disruptions = await loadDisruptions();
  const state = buildEdgeState(g, now, disruptions);
  const hits = edgesNear(g, lng, lat, radius)
    .sort((a, b) => a.meters - b.meters)
    .slice(0, MAX_EDGES);

  const counts = { green: 0, orange: 0, red: 0 };
  const edges = hits.map(({ edge }) => {
    const level = levelOf(state.congestion[edge]);
    counts[level] += 1;
    const points: [number, number][] = [[g.nodeLng[g.edgeA[edge]], g.nodeLat[g.edgeA[edge]]]];
    const geom = g.edgeGeom[edge];
    for (let k = 0; k < geom.length; k += 2) points.push([Number(geom[k].toFixed(6)), Number(geom[k + 1].toFixed(6))]);
    points.push([g.nodeLng[g.edgeB[edge]], g.nodeLat[g.edgeB[edge]]]);
    return { level, congestion: Math.round(state.congestion[edge] * 100), points };
  });

  return ok({
    available: true,
    provider: "osm-graph",
    estimated: true,
    simulated: at !== null,
    model: "time of day × road class × signalised junctions + reported disruptions",
    hour: state.hour,
    generatedAt: now.toISOString(),
    radiusMeters: radius,
    total: edges.length,
    counts,
    license: g.license,
    edges,
  });
});
