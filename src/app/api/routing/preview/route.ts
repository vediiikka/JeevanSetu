import { ok, readJson, requireLat, requireLng, route } from "@/lib/api";
import { loadDisruptions, loadSegments } from "@/lib/dispatch";
import { planRoadRoute } from "@/lib/roadRouting";

export const dynamic = "force-dynamic";

/**
 * Route options between two points. Body: originLat, originLng, destinationLat, destinationLng.
 * Optional: comparison (true) adds the Dijkstra vs A* comparison; at (ISO time) simulates a
 * time of day for demonstration and is reported as simulated.
 */
export const POST = route(async (request: Request) => {
  const body = await readJson(request);
  const origin = { lat: requireLat(body.originLat, "origin latitude"), lng: requireLng(body.originLng, "origin longitude") };
  const destination = {
    lat: requireLat(body.destinationLat, "destination latitude"),
    lng: requireLng(body.destinationLng, "destination longitude"),
  };
  const at = typeof body.at === "string" && !Number.isNaN(Date.parse(body.at)) ? new Date(body.at) : null;
  const [segments, disruptions] = await Promise.all([loadSegments(), loadDisruptions()]);
  const plan = await planRoadRoute({
    origin,
    destination,
    segments,
    disruptions,
    alternatives: 3,
    now: at ?? new Date(),
    withComparison: body.comparison === true,
    simulated: at !== null,
  });
  return ok({ plan });
});
