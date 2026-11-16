import { eq } from "@/db";
import { db } from "@/db";
import { emergencyRequests, routes, type RouteRow } from "@/db/schema";
import { HttpError } from "@/lib/auth";
import { ok, route } from "@/lib/api";
import { getRequestDetail, latestRouteFor, planFor, presentRoutePlan, routeKeyOf } from "@/lib/dispatch";

export const dynamic = "force-dynamic";

async function buildLeg(id: string) {
  const detail = await getRequestDetail(id);
  if (!detail) throw new HttpError(404, "Emergency request not found");
  const { request, ambulance, hospital } = detail;
  const pickup = { lat: request.pickupLat, lng: request.pickupLng };
  const onHospitalLeg = request.status === "enroute_hospital" || request.status === "arrived_hospital";
  const origin = ambulance ? { lat: ambulance.lat, lng: ambulance.lng } : pickup;
  const destination = onHospitalLeg ? (hospital ? { lat: hospital.lat, lng: hospital.lng } : null) : pickup;
  if (!destination) throw new HttpError(409, "This request has no destination hospital");
  return { detail, origin, destination, leg: onHospitalLeg ? ("hospital" as const) : ("pickup" as const) };
}

/** Route options for the current leg, with the route the ambulance is driving listed first. */
export const GET = route(async (_request: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { detail, origin, destination, leg } = await buildLeg(id);
  const stored = await latestRouteFor(detail.request.id);
  const plan = presentRoutePlan(await planFor(origin, destination, 3), stored);
  return ok({
    leg,
    plan,
    status: detail.request.status,
    etaMinutes: detail.request.etaMinutes,
    disruptions: plan.fastest?.disruptions ?? [],
    activeDisruptions: detail.disruptions.length,
  });
});

/** Recalculate the current leg from the ambulance's position, keeping the option the driver chose. */
export const POST = route(async (_request: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { detail, origin, destination, leg } = await buildLeg(id);
  const previous = await latestRouteFor(detail.request.id);
  const chosenKey = previous ? routeKeyOf(previous) : null;
  const fresh = await planFor(origin, destination, 3);
  const option = (chosenKey ? fresh.options.find((o) => o.key === chosenKey) : undefined) ?? fresh.fastest;
  if (!option) throw new HttpError(409, "No feasible route available with the current road conditions");

  const inserted = await db
    .insert(routes)
    .values({
      requestId: detail.request.id,
      mode: chosenKey ? `option:${option.key ?? chosenKey}` : "recalculate",
      origin: [origin.lng, origin.lat],
      destination: [destination.lng, destination.lat],
      geometry: option.geometry,
      distanceMeters: option.distanceMeters,
      durationSeconds: option.durationSeconds,
      alternatives: fresh.options
        .filter((o) => o !== option)
        .map((o) => ({
          key: o.key,
          label: o.label,
          durationSeconds: o.durationSeconds,
          distanceMeters: o.distanceMeters,
          delaySeconds: o.delaySeconds,
          traffic: o.traffic,
          algorithm: o.algorithm,
        })),
      disruptions: option.disruptions,
      trafficSummary: {
        level: option.traffic,
        delaySeconds: option.delaySeconds,
        key: option.key,
        label: option.label,
        algorithm: option.algorithm,
        overlapWithFastest: option.overlapWithFastest,
        trafficMix: option.trafficMix,
        segments: option.segments ?? [],
        steps: option.steps ?? [],
        leg,
      },
    })
    .returning();

  const etaMinutes = Math.max(1, Math.round(option.durationSeconds / 60));
  await db
    .update(emergencyRequests)
    .set({ etaMinutes, distanceKm: Number((option.distanceMeters / 1000).toFixed(2)), updatedAt: new Date() })
    .where(eq(emergencyRequests.id, detail.request.id));

  const stored = (inserted[0] as RouteRow | undefined) ?? null;
  return ok({
    leg,
    plan: presentRoutePlan(fresh, stored),
    status: detail.request.status,
    etaMinutes,
    disruptions: option.disruptions,
    activeDisruptions: detail.disruptions.length,
  });
});
