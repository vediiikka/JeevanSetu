import { and, desc, eq, inArray } from "@/db";
import { db } from "@/db";
import {
  ambulances,
  emergencyRequests,
  hospitals,
  notifications,
  rerouteEvents,
  roadDisruptions,
  routes,
} from "@/db/schema";
import type { RoadDisruption } from "@/db/schema";
import { projectOnPolyline } from "@/lib/geo";
import { planFor } from "@/lib/dispatch";

export type RerouteDecision = {
  requestId: number;
  publicId: string;
  action: "recalculated" | "no_alternative" | "no_change";
  reason: string;
  oldEtaMinutes: number | null;
  newEtaMinutes: number | null;
  oldDistanceMeters: number | null;
  newDistanceMeters: number | null;
  triggerDisruptionId: number | null;
  triggerTitle: string | null;
  routeId: number | null;
};

const AFFECT_RADIUS_METERS = 150;

function isBlockingDisruption(disruption: RoadDisruption): boolean {
  if (disruption.status !== "active") return false;
  if (!["closure", "waterlogging", "damaged_road"].includes(disruption.type)) return false;
  if (!["high", "critical"].includes(disruption.severity)) return false;
  if (!["verified", "community"].includes(disruption.verification)) return false;
  if (disruption.confidence < 0.6) return false;
  if (disruption.eventEndsAt && disruption.eventEndsAt.getTime() < Date.now()) return false;
  return true;
}

/**
 * Automatic rerouting monitor.
 *
 * For every active trip we check whether a newly reported / escalated disruption
 * intersects the *stored* route geometry. If it does we recompute the leg and
 * only switch when the new plan is materially better (or the current road is
 * blocked), which avoids route flapping. Every decision is persisted so the
 * admin dashboard and the driver can see exactly why an ETA changed.
 */
export async function monitorActiveRoutes(): Promise<{ monitored: number; decisions: RerouteDecision[] }> {
  const activeRequests = await db
    .select()
    .from(emergencyRequests)
    .where(inArray(emergencyRequests.status, ["assigned", "enroute_pickup", "enroute_hospital"]));

  const activeDisruptions = await db
    .select()
    .from(roadDisruptions)
    .where(eq(roadDisruptions.status, "active"));

  const decisions: RerouteDecision[] = [];

  for (const request of activeRequests) {
    const hospitalRows = request.hospitalId
      ? await db.select().from(hospitals).where(eq(hospitals.id, request.hospitalId)).limit(1)
      : [];
    const hospital = hospitalRows[0];
    if (!hospital) continue;

    const ambulanceRows = request.ambulanceId
      ? await db.select().from(ambulances).where(eq(ambulances.id, request.ambulanceId)).limit(1)
      : [];
    const ambulance = ambulanceRows[0];

    const isPickupLeg = request.status === "assigned" || request.status === "enroute_pickup";
    // Continue from where the unit is now — never restart from the patient's pickup point.
    const origin = ambulance
      ? { lat: ambulance.lat, lng: ambulance.lng }
      : { lat: request.pickupLat, lng: request.pickupLng };
    const destination = isPickupLeg
      ? { lat: request.pickupLat, lng: request.pickupLng }
      : { lat: hospital.lat, lng: hospital.lng };

    const latestRouteRows = await db
      .select()
      .from(routes)
      .where(eq(routes.requestId, request.id))
      .orderBy(desc(routes.id))
      .limit(1);
    const latestRoute = latestRouteRows[0];
    if (!latestRoute) continue;

    const routeLine = latestRoute.geometry.map(([lng, lat]: [number, number]) => ({ lat, lng }));
    if (routeLine.length < 2) continue;

    const affected = activeDisruptions
      .map((disruption) => ({
        disruption,
        distanceMeters: projectOnPolyline({ lat: disruption.lat, lng: disruption.lng }, routeLine).distanceMeters,
      }))
      .filter((item) => item.distanceMeters <= AFFECT_RADIUS_METERS)
      .sort((a, b) => a.distanceMeters - b.distanceMeters);

    if (affected.length === 0) continue;

    // Prefer the disruption that actually blocks the road when explaining the decision.
    const trigger = (affected.find((item) => isBlockingDisruption(item.disruption)) ?? affected[0]).disruption;
    const blocking = affected.some((item) => isBlockingDisruption(item.disruption));
    const oldEta = request.etaMinutes ?? Math.round(latestRoute.durationSeconds / 60);
    const oldDistance = latestRoute.distanceMeters;

    const plan = await planFor(origin, destination, 3);
    // Keep the route the driver chose (fast / slow) when it is still available; otherwise the fastest.
    const chosenKey = latestRoute.mode.startsWith("option:") ? latestRoute.mode.slice("option:".length) : null;
    const option = (chosenKey ? plan.options.find((o) => o.key === chosenKey) : undefined) ?? plan.fastest;

    if (!option) {
      await db.insert(rerouteEvents).values({
        requestId: request.id,
        reason: `No feasible alternative while "${trigger.title}" is active`,
        action: "no_alternative",
        oldEtaMinutes: oldEta,
        oldDistanceMeters: oldDistance,
        triggerDisruptionId: trigger.id,
      });
      await db.insert(notifications).values({
        role: "driver",
        userId: null,
        requestId: request.id,
        type: "reroute_no_alternative",
        title: `No alternative route · ${request.publicId}`,
        body: `"${trigger.title}" blocks the only feasible path. Hold position and contact the control room.`,
      });
      decisions.push({
        requestId: request.id,
        publicId: request.publicId,
        action: "no_alternative",
        reason: `No feasible alternative while "${trigger.title}" is active`,
        oldEtaMinutes: oldEta,
        newEtaMinutes: null,
        oldDistanceMeters: oldDistance,
        newDistanceMeters: null,
        triggerDisruptionId: trigger.id,
        triggerTitle: trigger.title,
        routeId: null,
      });
      continue;
    }

    const newEta = Math.max(1, Math.round(option.durationSeconds / 60));
    const improvement = oldEta > 0 ? (oldEta - newEta) / oldEta : 0;
    const shouldSwitch = blocking || improvement > 0.08 || option.distanceMeters < oldDistance * 0.9;

    if (!shouldSwitch) {
      await db.insert(rerouteEvents).values({
        requestId: request.id,
        reason: `Current route remains fastest despite "${trigger.title}" (ETA ${oldEta} → ${newEta} min, within hysteresis band)`,
        action: "no_change",
        oldEtaMinutes: oldEta,
        newEtaMinutes: newEta,
        oldDistanceMeters: oldDistance,
        newDistanceMeters: option.distanceMeters,
        triggerDisruptionId: trigger.id,
      });
      decisions.push({
        requestId: request.id,
        publicId: request.publicId,
        action: "no_change",
        reason: `Current route remains fastest despite "${trigger.title}"`,
        oldEtaMinutes: oldEta,
        newEtaMinutes: newEta,
        oldDistanceMeters: oldDistance,
        newDistanceMeters: option.distanceMeters,
        triggerDisruptionId: trigger.id,
        triggerTitle: trigger.title,
        routeId: latestRoute.id,
      });
      continue;
    }

    const insertedRoute = await db
      .insert(routes)
      .values({
        requestId: request.id,
        mode: option?.key && chosenKey ? `option:${option.key}` : "recalculate",
        origin: [origin.lng, origin.lat],
        destination: [destination.lng, destination.lat],
        geometry: option.geometry,
        distanceMeters: option.distanceMeters,
        durationSeconds: option.durationSeconds,
        alternatives: plan.options.slice(1),
        disruptions: option.disruptions,
        trafficSummary: {
          level: option.traffic,
          delaySeconds: option.delaySeconds,
          trigger: trigger.title,
          confidence: trigger.confidence,
          verification: trigger.verification,
        },
      })
      .returning();

    await db
      .update(emergencyRequests)
      .set({
        etaMinutes: newEta,
        distanceKm: Number((option.distanceMeters / 1000).toFixed(2)),
        updatedAt: new Date(),
      })
      .where(eq(emergencyRequests.id, request.id));

    const etaDelta = newEta - oldEta;
    const reason = blocking
      ? `"${trigger.title}" blocks the planned road — detour applied (ETA ${oldEta} → ${newEta} min${etaDelta > 0 ? `, +${etaDelta} min unavoidable` : ""})`
      : `"${trigger.title}" slows the planned road — faster alternative found (ETA ${oldEta} → ${newEta} min)`;

    await db.insert(rerouteEvents).values({
      requestId: request.id,
      routeId: insertedRoute[0]?.id ?? null,
      triggerDisruptionId: trigger.id,
      reason,
      action: "recalculated",
      oldEtaMinutes: oldEta,
      newEtaMinutes: newEta,
      oldDistanceMeters: oldDistance,
      newDistanceMeters: option.distanceMeters,
    });

    await db.insert(notifications).values({
      role: "driver",
      requestId: request.id,
      type: "reroute",
      title: `Route updated · ${request.publicId}`,
      body: `${reason}. ETA ${oldEta} → ${newEta} min. New guidance is on your console.`,
    });
    await db.insert(notifications).values({
      role: "admin",
      requestId: request.id,
      type: "reroute",
      title: `Automatic reroute · ${request.publicId}`,
      body: `${reason}. ETA ${oldEta} → ${newEta} min.`,
    });

    decisions.push({
      requestId: request.id,
      publicId: request.publicId,
      action: "recalculated",
      reason,
      oldEtaMinutes: oldEta,
      newEtaMinutes: newEta,
      oldDistanceMeters: oldDistance,
      newDistanceMeters: option.distanceMeters,
      triggerDisruptionId: trigger.id,
      triggerTitle: trigger.title,
      routeId: insertedRoute[0]?.id ?? null,
    });
  }

  return { monitored: activeRequests.length, decisions };
}

export async function listRerouteEvents(limit = 20) {
  const rows = await db.select().from(rerouteEvents).orderBy(desc(rerouteEvents.id)).limit(limit);
  const requestRows = await db.select().from(emergencyRequests);
  const byId = new Map(requestRows.map((request) => [request.id, request]));
  return rows.map((row) => ({ ...row, publicId: byId.get(row.requestId)?.publicId ?? null }));
}

export async function latestRerouteForRequest(requestId: number) {
  const rows = await db
    .select()
    .from(rerouteEvents)
    .where(and(eq(rerouteEvents.requestId, requestId), eq(rerouteEvents.action, "recalculated")))
    .orderBy(desc(rerouteEvents.id))
    .limit(1);
  return rows[0] ?? null;
}
