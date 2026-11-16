import { and, desc, eq, inArray, ne } from "@/db";
import { db } from "@/db";
import {
  ambulanceAssignments,
  ambulances,
  drivers,
  emergencyRequests,
  hospitals,
  notifications,
  patients,
  users,
  roadDisruptions,
  roadSegments,
  rerouteEvents,
  routes,
  trips,
} from "@/db/schema";
import type {
  Ambulance,
  Driver,
  EmergencyRequest,
  Hospital,
  RoadDisruption,
  RoadSegment,
  RouteRow,
  Trip,
} from "@/db/schema";
import { geohash, haversine, pointAlongPolyline, polylineLength, projectOnPolyline, type LatLng } from "@/lib/geo";
import { hospitalSuitability, statusLabel, type Role } from "@/lib/domain";
import {
  planRoute,
  type RouteOption,
  type RoutePlan,
  type RoutableDisruption,
  type RoutableSegment,
} from "@/lib/routing";
import { HttpError } from "@/lib/auth";
import { latestRerouteForRequest } from "@/lib/reroute";
import { planRoadRoute } from "@/lib/roadRouting";
import { fetchRoadTable } from "@/lib/roadRouter";
import type { DriverListItem } from "@/lib/driverProfileTypes";
import { isOptionKey } from "@/lib/graphRouting";

export type HospitalRow = Hospital;
export type AmbulanceRow = Ambulance;
export type RequestRow = EmergencyRequest;

export async function loadSegments(): Promise<RoutableSegment[]> {
  const rows = await db.select().from(roadSegments);
  return rows.map((r) => ({
    id: r.id,
    segmentCode: r.segmentCode,
    roadName: r.roadName,
    city: r.city,
    roadClass: r.roadClass,
    startNode: r.startNode,
    endNode: r.endNode,
    startLat: r.startLat,
    startLng: r.startLng,
    endLat: r.endLat,
    endLng: r.endLng,
    geometry: r.geometry,
    distanceMeters: r.distanceMeters,
    baseSpeedKph: r.baseSpeedKph,
    trafficLevel: r.trafficLevel,
    status: r.status,
  }));
}

export async function loadDisruptions(onlyActive = true): Promise<RoutableDisruption[]> {
  const rows = onlyActive
    ? await db.select().from(roadDisruptions).where(eq(roadDisruptions.status, "active"))
    : await db.select().from(roadDisruptions);
  return rows.map((r) => ({
    id: r.id,
    segmentId: r.segmentId,
    type: r.type,
    severity: r.severity,
    status: r.status,
    title: r.title,
    lat: r.lat,
    lng: r.lng,
    confidence: r.confidence,
    verification: r.verification,
    direction: r.direction,
    startsAt: r.startsAt,
    eventEndsAt: r.eventEndsAt,
    sourceKey: r.sourceKey,
    needsReview: r.needsReview,
  }));
}

export async function planFor(origin: LatLng, destination: LatLng, alternatives = 3): Promise<RoutePlan> {
  const [segments, disruptions] = await Promise.all([loadSegments(), loadDisruptions()]);
  return planRoadRoute({ origin, destination, segments, disruptions, alternatives });
}

export async function notify(params: {
  role: Role;
  userId?: number | null;
  requestId?: number | null;
  type: string;
  title: string;
  body?: string;
}): Promise<void> {
  await db.insert(notifications).values({
    role: params.role,
    userId: params.userId ?? null,
    requestId: params.requestId ?? null,
    type: params.type,
    title: params.title,
    body: params.body ?? "",
  });
}

async function nextPublicId(): Promise<string> {
  const rows = await db.select({ id: emergencyRequests.id }).from(emergencyRequests);
  return `JS-${1000 + rows.length + 1}`;
}

export type HospitalCandidate = {
  hospital: HospitalRow;
  durationSeconds: number;
  distanceMeters: number;
  suitability: number;
  score: number;
  missing: string[];
  matched: string[];
  option: RouteOption | null;
};

/**
 * Mode 1 — nearest *suitable* hospital.
 * Ranks hospitals by road travel time (not straight-line distance) blended with
 * emergency-care suitability for the reported category.
 */
export async function rankHospitals(
  pickup: LatLng,
  category: string,
  limit = 5,
): Promise<HospitalCandidate[]> {
  const [segments, disruptions, hospitalRows] = await Promise.all([
    loadSegments(),
    loadDisruptions(),
    db.select().from(hospitals).where(eq(hospitals.status, "active")),
  ]);
  const hospitalsList = hospitalRows as unknown as Hospital[];

  const nearby = hospitalsList
    .map((h) => ({ h, straight: haversine(pickup, { lat: h.lat, lng: h.lng }) }))
    .filter((x) => x.straight < 90_000)
    .sort((a, b) => a.straight - b.straight)
    .slice(0, 8);

  const nearbyHospitals = nearby as { h: Hospital }[];
  const plans = await Promise.all(
    nearbyHospitals.map(({ h }) =>
      planRoadRoute({
        origin: pickup,
        destination: { lat: h.lat, lng: h.lng },
        segments,
        disruptions,
        alternatives: 1,
      }),
    ),
  );
  const candidates: HospitalCandidate[] = [];
  for (const [index, { h }] of nearbyHospitals.entries()) {
    const plan = plans[index];
    const option = plan.fastest;
    if (!option) continue;
    const suitability = hospitalSuitability(h, category);
    // Travel time dominates, suitability breaks ties (seconds vs 0-100 points).
    const timePenalty = option.durationSeconds;
    const suitabilityBonus = (100 - suitability.score) * 25;
    candidates.push({
      hospital: h,
      durationSeconds: option.durationSeconds,
      distanceMeters: option.distanceMeters,
      suitability: suitability.score,
      score: timePenalty + suitabilityBonus,
      missing: suitability.missing,
      matched: suitability.matched,
      option,
    });
  }
  return candidates.sort((a, b) => a.score - b.score).slice(0, limit);
}

export type CreateRequestInput = {
  channel?: "app" | "control_room";
  patientName: string;
  patientPhone: string;
  category: string;
  severity: string;
  mode: "nearest" | "desired";
  pickup: LatLng;
  pickupAddress?: string;
  preferredHospitalId?: number | null;
  notes?: string;
};

export type CreateRequestResult = {
  ambulanceCandidates: AmbulanceCandidate[];
  request: RequestRow;
  hospital: HospitalRow | null;
  candidates: HospitalCandidate[];
  assignment: {
    ambulance: AmbulanceRow;
    driver: Driver | null;
    route: RouteOption | null;
  } | null;
};

export async function createEmergencyRequest(input: CreateRequestInput): Promise<CreateRequestResult> {
  let hospital: HospitalRow | null = null;
  let candidates: HospitalCandidate[] = [];

  if (input.mode === "desired") {
    if (!input.preferredHospitalId) throw new HttpError(400, "Select a hospital for desired-hospital mode");
    const rows = await db.select().from(hospitals).where(eq(hospitals.id, input.preferredHospitalId)).limit(1);
    hospital = (rows[0] as unknown as Hospital) ?? null;
    if (!hospital) throw new HttpError(404, "Selected hospital was not found");
    if (hospital.status !== "active") throw new HttpError(400, "Selected hospital is not accepting emergency cases");
  } else {
    candidates = await rankHospitals(input.pickup, input.category, 3);
    if (candidates.length === 0) {
      throw new HttpError(409, "No feasible hospital with an emergency route was found. Please try desired-hospital mode.");
    }
    hospital = candidates[0].hospital;
  }

  const publicId = await nextPublicId();
  const insertedPatient = await db
    .insert(patients)
    .values({
      name: input.patientName,
      phone: input.patientPhone,
      lat: input.pickup.lat,
      lng: input.pickup.lng,
      geohash: geohash(input.pickup.lat, input.pickup.lng),
      address: input.pickupAddress ?? "",
    })
    .returning();

  const insertedRequest = await db
    .insert(emergencyRequests)
    .values({
      publicId,
      patientId: insertedPatient[0]?.id ?? null,
      patientName: input.patientName,
      patientPhone: input.patientPhone,
      category: input.category,
      severity: input.severity,
      status: "pending",
      mode: input.mode,
      preferredHospitalId: input.preferredHospitalId ?? null,
      hospitalId: hospital.id,
      pickupLat: input.pickup.lat,
      pickupLng: input.pickup.lng,
      pickupAddress: input.pickupAddress ?? "",
      notes: input.notes ?? "",
      channel: input.channel ?? "app",
    })
    .returning();

  const request = insertedRequest[0];
  await notify({
    role: "admin",
    requestId: request.id,
    type: "request_created",
    title: `New ${input.severity} emergency · ${publicId}`,
    body: `${input.category} case from ${input.pickupAddress || "GPS location"}`,
  });

  const { assignment, candidates: ambulanceCandidates } = await assignNearestAmbulance(request.id);
  const refreshed = await db.select().from(emergencyRequests).where(eq(emergencyRequests.id, request.id)).limit(1);
  return { request: refreshed[0] ?? request, hospital, candidates, assignment, ambulanceCandidates };
}

export type AssignmentResult = {
  ambulance: AmbulanceRow;
  driver: Driver | null;
  route: RouteOption | null;
};

export type AmbulanceCandidate = {
  ambulanceId: number;
  code: string;
  type: string;
  /** selected = dispatched · ranked = feasible, not chosen · unreachable = no road route · unavailable = busy/offline */
  status: "selected" | "ranked" | "unreachable" | "unavailable";
  roadDistanceMeters: number | null;
  roadDurationSeconds: number | null;
  straightLineMeters: number;
  basis: "road_table" | "estimate" | "none";
  reason: string;
};

/** How many of the closest-by-road ambulances get a full disruption-aware route. */
const SHORTLIST_SIZE = 5;

/**
 * Ambulance allocation engine.
 * Candidates are ranked by *road* travel time to the patient. The chosen row is
 * claimed with a conditional UPDATE (status = 'available') so two concurrent
 * dispatch loops can never assign the same ambulance twice.
 */
/**
 * Ambulance allocation: the closest unit BY ROAD.
 *
 * 1. Every available ambulance is ranked by road travel time to the patient in ONE
 *    OSRM table request (straight-line distance is only a fallback estimate).
 * 2. The closest few get a full disruption-aware road route (closures, penalties).
 * 3. The fastest feasible unit is claimed with a conditional update, so two
 *    simultaneous requests can never take the same ambulance.
 */
export async function assignNearestAmbulance(
  requestId: number,
  excludeAmbulanceIds: number[] = [],
): Promise<{ assignment: AssignmentResult | null; candidates: AmbulanceCandidate[] }> {
  const requestRows = await db.select().from(emergencyRequests).where(eq(emergencyRequests.id, requestId)).limit(1);
  const request = requestRows[0];
  if (!request) throw new HttpError(404, "Emergency request not found");

  const pickup = { lat: request.pickupLat, lng: request.pickupLng };
  const fleetRows = await db.select().from(ambulances);
  const fleet = fleetRows.filter((a) => a.status === "available" && !excludeAmbulanceIds.includes(a.id));
  const unavailable: AmbulanceCandidate[] = fleetRows
    .filter((a) => a.status !== "available" && !excludeAmbulanceIds.includes(a.id))
    .map((a) => ({
      ambulanceId: a.id,
      code: a.code,
      type: a.type,
      status: "unavailable" as const,
      roadDistanceMeters: null,
      roadDurationSeconds: null,
      straightLineMeters: Math.round(haversine(pickup, { lat: a.lat, lng: a.lng })),
      basis: "none" as const,
      reason: `Not available (${statusLabel(a.status).toLowerCase()})`,
    }));
  if (fleet.length === 0) return { assignment: null, candidates: unavailable };

  // 1. Road time from every available unit to the patient, in one request.
  const table = await fetchRoadTable(
    fleet.map((a) => ({ lat: a.lat, lng: a.lng })),
    pickup,
  );
  const basis: "road_table" | "estimate" = table.provider === "osrm" ? "road_table" : "estimate";
  const ranking = fleet
    .map((a, index) => {
      const straight = haversine(pickup, { lat: a.lat, lng: a.lng });
      const roadDuration = table.provider === "osrm" ? table.durations[index] : null;
      const roadDistance = table.provider === "osrm" ? table.distances[index] : null;
      // Without a road table, order by straight line with a 1.35 detour factor at 40 km/h.
      const estimateSeconds = (straight * 1.35) / (40 / 3.6);
      return {
        a,
        straight,
        roadDistance,
        roadDuration,
        unreachable: table.provider === "osrm" && roadDuration === null,
        sortSeconds: roadDuration ?? estimateSeconds,
      };
    })
    .sort((x, y) => x.sortSeconds - y.sortSeconds);

  const reachable = ranking.filter((row) => !row.unreachable);
  const shortlist = reachable.slice(0, SHORTLIST_SIZE);

  // 2. Disruption-aware road routes for the closest few.
  const [segments, disruptions] = await Promise.all([loadSegments(), loadDisruptions()]);
  const plans = await Promise.all(
    shortlist.map((row) =>
      planRoadRoute({
        origin: { lat: row.a.lat, lng: row.a.lng },
        destination: pickup,
        segments,
        disruptions,
        alternatives: 1,
      }),
    ),
  );
  const routed = shortlist
    .map((row, index) => ({ ...row, option: plans[index].fastest }))
    .filter((row): row is typeof row & { option: RouteOption } => row.option !== null)
    .sort((x, y) => x.option.durationSeconds - y.option.durationSeconds);

  const selectedId = { value: null as number | null };
  const buildCandidates = (): AmbulanceCandidate[] => {
    const routedById = new Map(routed.map((row) => [row.a.id, row]));
    const rows: AmbulanceCandidate[] = ranking.map((row) => {
      const planned = routedById.get(row.a.id);
      let status: AmbulanceCandidate["status"];
      let reason: string;
      if (selectedId.value === row.a.id) {
        status = "selected";
        reason = "Closest by road — dispatched";
      } else if (row.unreachable || (shortlist.includes(row) && !planned)) {
        status = "unreachable";
        reason = "No road route to the patient";
      } else if (planned) {
        status = "ranked";
        reason = "Feasible, but further by road";
      } else {
        status = "ranked";
        reason = "Further by road (not routed)";
      }
      return {
        ambulanceId: row.a.id,
        code: row.a.code,
        type: row.a.type,
        status,
        roadDistanceMeters: planned ? planned.option.distanceMeters : row.roadDistance !== null ? Math.round(row.roadDistance) : null,
        roadDurationSeconds: planned ? planned.option.durationSeconds : row.roadDuration !== null ? Math.round(row.roadDuration) : null,
        straightLineMeters: Math.round(row.straight),
        basis,
        reason,
      };
    });
    return [...rows, ...unavailable];
  };

  // 3. Claim the fastest feasible unit atomically.
  for (const { a, option } of routed) {
    const claimed = await db
      .update(ambulances)
      .set({ status: "assigned", lastSeenAt: new Date() })
      .where(and(eq(ambulances.id, a.id), eq(ambulances.status, "available")))
      .returning();
    const ambulance = claimed[0];
    if (!ambulance) continue; // lost the race — next candidate

    selectedId.value = ambulance.id;
    const driverRows = ambulance.driverId
      ? await db.select().from(drivers).where(eq(drivers.id, ambulance.driverId)).limit(1)
      : [];
    const driver = driverRows[0] ?? null;

    await db.insert(ambulanceAssignments).values({
      requestId,
      ambulanceId: ambulance.id,
      driverId: ambulance.driverId,
      status: "pending",
    });

    await db.insert(trips).values({
      requestId,
      ambulanceId: ambulance.id,
      driverId: ambulance.driverId ?? 0,
      status: "to_pickup",
      distanceKm: option.distanceMeters / 1000,
      durationSeconds: option.durationSeconds,
    });

    await db.insert(routes).values({
      requestId,
      mode: "nearest",
      origin: [ambulance.lng, ambulance.lat],
      destination: [pickup.lng, pickup.lat],
      geometry: option.geometry,
      distanceMeters: option.distanceMeters,
      durationSeconds: option.durationSeconds,
      alternatives: [],
      disruptions: option.disruptions,
      trafficSummary: { level: option.traffic, delaySeconds: option.delaySeconds },
    });

    await db
      .update(emergencyRequests)
      .set({
        status: "assigned",
        ambulanceId: ambulance.id,
        driverId: ambulance.driverId,
        etaMinutes: Math.max(1, Math.round(option.durationSeconds / 60)),
        distanceKm: Number((option.distanceMeters / 1000).toFixed(2)),
        updatedAt: new Date(),
      })
      .where(eq(emergencyRequests.id, requestId));

    if (driver) {
      await db.update(drivers).set({ status: "on_trip", ambulanceId: ambulance.id }).where(eq(drivers.id, driver.id));
    }

    await notify({
      role: "driver",
      userId: driver?.userId ?? null,
      requestId,
      type: "assignment",
      title: `New emergency assigned · ${request.publicId}`,
      body: `Pickup: ${request.pickupAddress || "GPS location"} · ETA ${Math.max(1, Math.round(option.durationSeconds / 60))} min`,
    });
    await notify({
      role: "admin",
      requestId,
      type: "assignment",
      title: `${ambulance.code} assigned to ${request.publicId}`,
      body: `Closest by road (${(option.distanceMeters / 1000).toFixed(1)} km, ${Math.max(1, Math.round(option.durationSeconds / 60))} min) · driver ${driver?.name ?? "not linked"} notified`,
    });

    return {
      assignment: { ambulance, driver, route: option },
      candidates: buildCandidates(),
    };
  }

  return { assignment: null, candidates: buildCandidates() };
}

async function loadRequestOrThrow(requestId: number): Promise<RequestRow> {
  const rows = await db.select().from(emergencyRequests).where(eq(emergencyRequests.id, requestId)).limit(1);
  if (!rows[0]) throw new HttpError(404, "Emergency request not found");
  return rows[0];
}

async function loadTripForRequest(requestId: number) {
  const rows = await db
    .select()
    .from(trips)
    .where(eq(trips.requestId, requestId))
    .orderBy(desc(trips.id))
    .limit(1);
  return rows[0] ?? null;
}

export async function respondToAssignment(params: {
  requestId: number;
  driverId: number;
  action: "accept" | "reject";
  reason?: string;
}): Promise<{ reassigned: boolean }> {
  const request = await loadRequestOrThrow(params.requestId);
  const assignmentRows = await db
    .select()
    .from(ambulanceAssignments)
    .where(
      and(
        eq(ambulanceAssignments.requestId, params.requestId),
        eq(ambulanceAssignments.status, "pending"),
      ),
    )
    .orderBy(desc(ambulanceAssignments.id))
    .limit(1);
  const assignment = assignmentRows[0];
  if (!assignment) throw new HttpError(409, "No pending assignment to respond to");
  if (assignment.driverId !== params.driverId) throw new HttpError(403, "This assignment belongs to another driver");

  if (params.action === "reject") {
    await db
      .update(ambulanceAssignments)
      .set({ status: "rejected", reason: params.reason ?? "Rejected by driver", respondedAt: new Date() })
      .where(eq(ambulanceAssignments.id, assignment.id));
    await db
      .update(ambulances)
      .set({ status: "available" })
      .where(and(eq(ambulances.id, assignment.ambulanceId), eq(ambulances.status, "assigned")));
    await db.delete(trips).where(and(eq(trips.requestId, params.requestId), eq(trips.status, "to_pickup")));
    await db
      .update(emergencyRequests)
      .set({ status: "pending", ambulanceId: null, driverId: null, etaMinutes: null, updatedAt: new Date() })
      .where(eq(emergencyRequests.id, params.requestId));
    const { assignment: next } = await assignNearestAmbulance(params.requestId, [assignment.ambulanceId]);
    await notify({
      role: "admin",
      requestId: params.requestId,
      type: "assignment_rejected",
      title: `Driver rejected ${request.publicId}`,
      body: next ? `Reassigned to ${next.ambulance.code}` : "No other ambulance available — needs manual dispatch",
    });
    return { reassigned: Boolean(next) };
  }

  await db
    .update(ambulanceAssignments)
    .set({ status: "accepted", respondedAt: new Date() })
    .where(eq(ambulanceAssignments.id, assignment.id));
  await db
    .update(emergencyRequests)
    .set({ status: "enroute_pickup", updatedAt: new Date() })
    .where(eq(emergencyRequests.id, params.requestId));
  await db
    .update(ambulances)
    .set({ status: "on_trip", lastSeenAt: new Date() })
    .where(eq(ambulances.id, assignment.ambulanceId));
  await db.update(trips).set({ acceptedAt: new Date(), status: "to_pickup" }).where(eq(trips.requestId, params.requestId));
  await notify({
    role: "admin",
    requestId: params.requestId,
    type: "assignment_accepted",
    title: `Driver accepted ${request.publicId}`,
    body: "Ambulance is navigating to the patient pickup point",
  });
  return { reassigned: false };
}

/**
 * Destination after pickup, chosen from the patient's exact pickup point at the moment of
 * pickup. Nearest-mode requests get the nearest suitable hospital by road time. Desired-hospital
 * requests keep the hospital the patient asked for, and fall back to the nearest one only if
 * that hospital is inactive or has no road route.
 */
async function chooseHospitalAfterPickup(
  request: RequestRow,
  pickup: LatLng,
): Promise<{ hospital: HospitalRow; option: RouteOption } | null> {
  if (request.mode === "desired" && request.hospitalId) {
    const rows = await db.select().from(hospitals).where(eq(hospitals.id, request.hospitalId)).limit(1);
    const desired = rows[0] as unknown as HospitalRow | undefined;
    if (desired && desired.status === "active") {
      const plan = await planFor(pickup, { lat: desired.lat, lng: desired.lng }, 3);
      if (plan.fastest) return { hospital: desired, option: plan.fastest };
    }
  }
  const ranked = await rankHospitals(pickup, request.category, 3);
  for (const candidate of ranked) {
    if (candidate.option) return { hospital: candidate.hospital, option: candidate.option };
  }
  return null;
}

export async function confirmPickup(params: {
  requestId: number;
  driverId: number;
  method: "geofence" | "manual";
}): Promise<{ route: RouteOption | null; hospital: HospitalRow | null }> {
  const request = await loadRequestOrThrow(params.requestId);
  if (request.driverId !== params.driverId) throw new HttpError(403, "This trip is assigned to another driver");
  if (["enroute_hospital", "arrived_hospital", "completed", "cancelled"].includes(request.status)) {
    return { route: null, hospital: null };
  }

  // Claim the hand-off first: the route engine and the crew's button can never both run it.
  const claimed = await db
    .update(emergencyRequests)
    .set({ status: "enroute_hospital", updatedAt: new Date() })
    .where(
      and(
        eq(emergencyRequests.id, request.id),
        inArray(emergencyRequests.status, ["assigned", "accepted", "enroute_pickup"]),
      ),
    )
    .returning();
  if (claimed.length === 0) return { route: null, hospital: null };

  try {
    const pickup = { lat: request.pickupLat, lng: request.pickupLng };
    const choice = await chooseHospitalAfterPickup(request, pickup);
    if (!choice) throw new HttpError(409, "No feasible road route from the patient to a suitable hospital");
    const { hospital, option } = choice;
    const destination = { lat: hospital.lat, lng: hospital.lng };
    const now = new Date();
    const etaMinutes = Math.max(1, Math.round(option.durationSeconds / 60));

    // The hospital leg is stored as the active route, starting at the patient's pickup point.
    await db.insert(routes).values({
      requestId: request.id,
      mode: "post_pickup",
      origin: [pickup.lng, pickup.lat],
      destination: [destination.lng, destination.lat],
      geometry: option.geometry,
      distanceMeters: option.distanceMeters,
      durationSeconds: option.durationSeconds,
      alternatives: [],
      disruptions: option.disruptions,
      trafficSummary: { level: option.traffic, delaySeconds: option.delaySeconds },
    });

    await db
      .update(trips)
      .set({
        status: "to_hospital",
        arrivedPickupAt: now,
        pickedUpAt: now,
        distanceKm: Number((option.distanceMeters / 1000).toFixed(2)),
        durationSeconds: option.durationSeconds,
      })
      .where(eq(trips.requestId, request.id));

    await db
      .update(emergencyRequests)
      .set({
        status: "enroute_hospital",
        hospitalId: hospital.id,
        etaMinutes,
        distanceKm: Number((option.distanceMeters / 1000).toFixed(2)),
        updatedAt: now,
      })
      .where(eq(emergencyRequests.id, request.id));

    await db.insert(rerouteEvents).values({
      requestId: request.id,
      reason: `Patient picked up. Nearest suitable hospital from the patient's location: ${hospital.name} (${etaMinutes} min by road).`,
      action: "hospital_selected",
      oldEtaMinutes: null,
      newEtaMinutes: etaMinutes,
      oldDistanceMeters: null,
      newDistanceMeters: option.distanceMeters,
    });

    await notify({
      role: "driver",
      userId: null,
      requestId: request.id,
      type: "pickup_confirmed",
      title: `Patient on board · ${request.publicId}`,
      body: `Drive to ${hospital.name} (${etaMinutes} min, ${(option.distanceMeters / 1000).toFixed(1)} km by road).`,
    });
    await notify({
      role: "admin",
      requestId: request.id,
      type: "pickup_confirmed",
      title: `Patient picked up · ${request.publicId}`,
      body: `${params.method === "geofence" ? "Arrival detected" : "Confirmed by crew"} · en route to ${hospital.name} (${etaMinutes} min)`,
    });

    return { route: option, hospital };
  } catch (error) {
    // Hand the trip back so the next engine tick (or the crew) can retry the hand-off.
    await db
      .update(emergencyRequests)
      .set({ status: "enroute_pickup", updatedAt: new Date() })
      .where(and(eq(emergencyRequests.id, request.id), eq(emergencyRequests.status, "enroute_hospital")));
    throw error;
  }
}

export async function markArrivedAtHospital(params: { requestId: number; driverId: number }): Promise<void> {
  const request = await loadRequestOrThrow(params.requestId);
  if (request.driverId !== params.driverId) throw new HttpError(403, "This trip is assigned to another driver");
  await db
    .update(emergencyRequests)
    .set({ status: "arrived_hospital", updatedAt: new Date() })
    .where(eq(emergencyRequests.id, params.requestId));
  await db
    .update(trips)
    .set({ arrivedHospitalAt: new Date() })
    .where(eq(trips.requestId, params.requestId));
  await notify({
    role: "admin",
    requestId: request.id,
    type: "hospital_arrival",
    title: `Ambulance arrived at hospital · ${request.publicId}`,
    body: "Handover in progress",
  });
}

export async function completeTrip(params: { requestId: number; driverId: number }): Promise<void> {
  const request = await loadRequestOrThrow(params.requestId);
  if (request.driverId !== params.driverId) throw new HttpError(403, "This trip is assigned to another driver");
  const hospitalRows = request.hospitalId
    ? await db.select().from(hospitals).where(eq(hospitals.id, request.hospitalId)).limit(1)
    : [];
  const hospital = hospitalRows[0];

  const now = new Date();
  await db
    .update(emergencyRequests)
    .set({ status: "completed", completedAt: now, updatedAt: now })
    .where(eq(emergencyRequests.id, request.id));
  await db
    .update(trips)
    .set({ status: "completed", completedAt: now })
    .where(eq(trips.requestId, request.id));

  if (request.ambulanceId) {
    await db
      .update(ambulances)
      .set({
        status: "available",
        lat: hospital?.lat ?? request.pickupLat,
        lng: hospital?.lng ?? request.pickupLng,
        geohash: geohash(hospital?.lat ?? request.pickupLat, hospital?.lng ?? request.pickupLng),
        lastSeenAt: now,
      })
      .where(eq(ambulances.id, request.ambulanceId));
  }
  if (request.driverId) {
    await db.update(drivers).set({ status: "online" }).where(eq(drivers.id, request.driverId));
  }
  await notify({
    role: "admin",
    requestId: request.id,
    type: "trip_completed",
    title: `Trip completed · ${request.publicId}`,
    body: "Ambulance released back to the available pool",
  });
}

export async function updateAmbulancePosition(params: {
  ambulanceId: number;
  lat: number;
  lng: number;
  source?: "driver" | "engine" | "simulation";
}): Promise<void> {
  await db
    .update(ambulances)
    .set({
      lat: params.lat,
      lng: params.lng,
      geohash: geohash(params.lat, params.lng),
      lastSeenAt: new Date(),
      movementSource: params.source ?? "engine",
    })
    .where(eq(ambulances.id, params.ambulanceId));
  await db
    .update(drivers)
    .set({ lat: params.lat, lng: params.lng, geohash: geohash(params.lat, params.lng), lastSeenAt: new Date() })
    .where(eq(drivers.ambulanceId, params.ambulanceId));
}

/**
 * Demo helper: move an ambulance along its active route geometry. Used by the
 * driver console "simulate movement" control so the workflow can be exercised
 * without a physical vehicle.
 */
export async function advanceAmbulanceAlongRoute(params: {
  ambulanceId: number;
  meters: number;
}): Promise<{ lat: number; lng: number; remainingMeters: number; arrived: boolean; pickupConfirmed: boolean }> {
  const rows = await db.select().from(ambulances).where(eq(ambulances.id, params.ambulanceId)).limit(1);
  const ambulance = rows[0];
  if (!ambulance) throw new HttpError(404, "Ambulance not found");

  const requestRows = await db
    .select()
    .from(emergencyRequests)
    .where(and(eq(emergencyRequests.ambulanceId, params.ambulanceId), inArray(emergencyRequests.status, ["assigned", "enroute_pickup", "enroute_hospital"])))
    .orderBy(desc(emergencyRequests.id))
    .limit(1);
  const request = requestRows[0];
  if (!request) throw new HttpError(409, "Ambulance has no active trip");

  const routeRows = await db
    .select()
    .from(routes)
    .where(eq(routes.requestId, request.id))
    .orderBy(desc(routes.id))
    .limit(1);
  const route = routeRows[0];
  if (!route) throw new HttpError(409, "No route available for this trip");

  const line = route.geometry.map(([lng, lat]: [number, number]) => ({ lat, lng }));
  const total = polylineLength(line);
  const current = { lat: ambulance.lat, lng: ambulance.lng };
  // Distance already covered = projection of the current position on the line.
  let covered = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  let accumulated = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const segLen = haversine(line[i], line[i + 1]);
    const steps = Math.max(1, Math.round(segLen / 50));
    for (let s = 0; s <= steps; s += 1) {
      const p = pointAlongPolyline([line[i], line[i + 1]], (segLen * s) / steps);
      const d = haversine(current, p);
      if (d < bestDistance) {
        bestDistance = d;
        covered = accumulated + (segLen * s) / steps;
      }
    }
    accumulated += segLen;
  }

  const nextCovered = Math.min(total, covered + params.meters);
  const next = pointAlongPolyline(line, nextCovered);
  const arrived = nextCovered >= total - 25;
  await updateAmbulancePosition({ ambulanceId: ambulance.id, lat: next.lat, lng: next.lng, source: "simulation" });

  // Server-side geofence: arriving within 150 m of the patient confirms the pickup.
  let pickupConfirmed = false;
  if (request.status === "enroute_pickup") {
    const distanceToPatient = haversine(next, { lat: request.pickupLat, lng: request.pickupLng });
    if (distanceToPatient <= 150) {
      await confirmPickup({ requestId: request.id, driverId: request.driverId ?? 0, method: "geofence" });
      pickupConfirmed = true;
    }
  }

  return {
    lat: next.lat,
    lng: next.lng,
    remainingMeters: Math.max(0, Math.round(total - nextCovered)),
    arrived,
    pickupConfirmed,
  };
}

/** How far (0..1) a point sits along a polyline. */
export function projectProgress(point: LatLng, line: LatLng[]): number {
  const total = polylineLength(line);
  if (total <= 0) return 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestAlong = 0;
  let accumulated = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const segmentLength = haversine(line[i], line[i + 1]);
    const projection = projectOnPolyline(point, [line[i], line[i + 1]]);
    if (projection.distanceMeters < bestDistance) {
      bestDistance = projection.distanceMeters;
      bestAlong = accumulated + projection.alongMeters;
    }
    accumulated += segmentLength;
  }
  return Math.max(0, Math.min(1, bestAlong / total));
}

/**
 * Live ambulance movement engine.
 *
 * Every active trip's ambulance is advanced *along the stored road geometry* in
 * proportion to the elapsed time versus the route's estimated duration, so the
 * unit visibly drives the fastest path on every map (patient, driver, admin).
 * Real driver GPS always wins: if the crew reported a position in the last few
 * seconds the engine leaves the unit alone.
 */
let engineInFlight: Promise<{ moved: number; arrived: number }> | null = null;

/**
 * Live movement engine. Driver, patient and admin polls all call this; concurrent
 * callers share one in-flight run so pickup/arrival transitions happen exactly once.
 */
export function advanceActiveAmbulances(): Promise<{ moved: number; arrived: number }> {
  if (!engineInFlight) {
    engineInFlight = runMovementEngine().finally(() => {
      engineInFlight = null;
    });
  }
  return engineInFlight;
}

/** A position further than this from the route is considered off-road and is snapped back. */
const ON_ROUTE_TOLERANCE_M = 15;

/**
 * Safety bound only: a unit advances by the real time since it was last updated, so its
 * position is exact however often it is polled. This stops a corrupted timestamp from
 * sending a unit to the destination in one step.
 */
const MAX_STEP_SECONDS = 600;
/** Within this distance (m) of the end of a leg the unit has reached it. */
const ARRIVAL_METERS = 12;

/**
 * Live movement. Each active unit moves forward from where it IS along its current
 * road route, at the leg's planned average speed, for the time since it was last
 * updated. Nothing is ever restarted from the route's start, so a unit that is
 * already part-way along the hospital road keeps going instead of waiting or
 * returning to the patient.
 */
async function runMovementEngine(): Promise<{ moved: number; arrived: number }> {
  const active = await db
    .select()
    .from(emergencyRequests)
    .where(inArray(emergencyRequests.status, ["enroute_pickup", "enroute_hospital"]));

  let moved = 0;
  let arrived = 0;
  const now = Date.now();

  for (const request of active) {
    if (!request.ambulanceId) continue;
    const ambulance = (await db.select().from(ambulances).where(eq(ambulances.id, request.ambulanceId)).limit(1))[0];
    if (!ambulance) continue;
    const route = (
      await db.select().from(routes).where(eq(routes.requestId, request.id)).orderBy(desc(routes.id)).limit(1)
    )[0];
    if (!route || route.geometry.length < 2) continue;

    const line = route.geometry.map(([lng, lat]: [number, number]) => ({ lat, lng }));
    const total = polylineLength(line);
    const destination = line[line.length - 1];
    const current = { lat: ambulance.lat, lng: ambulance.lng };
    const lastSeen = ambulance.lastSeenAt ? new Date(ambulance.lastSeenAt).getTime() : now;

    // Projection of the unit onto the current road route (snaps it onto the road).
    const projection =
      total > 0
        ? projectOnPolyline(current, line)
        : { distanceMeters: haversine(current, destination), alongMeters: 0 };

    // A device fix that lies on the route is authoritative for a few seconds.
    if (
      ambulance.movementSource === "driver" &&
      now - lastSeen < 8000 &&
      projection.distanceMeters <= GPS_ROUTE_TOLERANCE_M
    ) {
      continue;
    }

    const alongMeters = Math.min(total, projection.alongMeters);
    const remainingMeters = Math.max(0, total - alongMeters);
    const speedMps = total > 0 && route.durationSeconds > 0 ? total / route.durationSeconds : 0;
    const stepSeconds = Math.min(MAX_STEP_SECONDS, Math.max(0, (now - lastSeen) / 1000));
    const reached = total <= 0 || remainingMeters - stepSeconds * speedMps <= ARRIVAL_METERS;
    const nextAlong = reached ? total : Math.min(total, alongMeters + stepSeconds * speedMps);
    const point = reached ? destination : pointAlongPolyline(line, nextAlong);
    if (!reached && haversine(current, point) < 0.5) continue;

    await db
      .update(ambulances)
      .set({
        lat: point.lat,
        lng: point.lng,
        geohash: geohash(point.lat, point.lng),
        lastSeenAt: new Date(now),
        movementSource: "engine",
      })
      .where(eq(ambulances.id, ambulance.id));
    moved += 1;

    if (reached && request.driverId) {
      if (request.status === "enroute_pickup") {
        await confirmPickup({ requestId: request.id, driverId: request.driverId, method: "geofence" });
        arrived += 1;
      } else if (request.status === "enroute_hospital") {
        await markArrivedAtHospital({ requestId: request.id, driverId: request.driverId });
        arrived += 1;
      }
    }
  }

  return { moved, arrived };
}

/** Max distance (m) between a device GPS fix and the route for the fix to be trusted. */
const GPS_ROUTE_TOLERANCE_M = 60;

/**
 * Device GPS from the driver's phone/browser. During an active trip the fix is only
 * used if it lies on the assigned road route; otherwise the route engine keeps the
 * ambulance on the road and the fix is recorded as off-route.
 */
export async function ingestDriverGps(params: {
  driverId: number;
  ambulanceId: number;
  lat: number;
  lng: number;
}): Promise<{ accepted: boolean; offRouteMeters: number | null; reason: string }> {
  await db
    .update(drivers)
    .set({ lat: params.lat, lng: params.lng, geohash: geohash(params.lat, params.lng), lastSeenAt: new Date() })
    .where(eq(drivers.id, params.driverId));

  const activeRequest = (
    await db
      .select()
      .from(emergencyRequests)
      .where(
        and(
          eq(emergencyRequests.ambulanceId, params.ambulanceId),
          inArray(emergencyRequests.status, ["assigned", "enroute_pickup", "enroute_hospital"]),
        ),
      )
      .orderBy(desc(emergencyRequests.id))
      .limit(1)
  )[0];

  if (!activeRequest) {
    // Outside a trip the device location is recorded for the crew only. The ambulance's
    // dispatch position is never overwritten by a phone that may not be in the vehicle.
    return {
      accepted: true,
      offRouteMeters: null,
      reason: "Device location recorded. Outside a trip the ambulance's dispatch position is not changed by device GPS.",
    };
  }

  const route = (
    await db.select().from(routes).where(eq(routes.requestId, activeRequest.id)).orderBy(desc(routes.id)).limit(1)
  )[0];
  if (!route || route.geometry.length < 2) {
    return { accepted: false, offRouteMeters: null, reason: "Trip has no road route yet." };
  }
  const line = route.geometry.map(([lng, lat]: [number, number]) => ({ lat, lng }));
  const offRouteMeters = Math.round(projectOnPolyline({ lat: params.lat, lng: params.lng }, line).distanceMeters);
  if (offRouteMeters > GPS_ROUTE_TOLERANCE_M) {
    return {
      accepted: false,
      offRouteMeters,
      reason: `Device location is ${offRouteMeters} m off the assigned road route. The ambulance follows the route.`,
    };
  }
  await updateAmbulancePosition({ ambulanceId: params.ambulanceId, lat: params.lat, lng: params.lng, source: "driver" });
  return { accepted: true, offRouteMeters, reason: "Device position is on the route." };
}

export type LiveStage = "available" | "offline" | "assigned" | "to_patient" | "to_hospital" | "at_hospital" | "idle";

export type TimelineEntry = { key: string; label: string; at: string | null };

export type AdminLiveRouteInfo = {
  id: number;
  purpose: "pickup" | "hospital";
  geometry: [number, number][];
  durationSeconds: number;
  distanceMeters: number;
  createdAt: string;
  engine: string;
  optionKey: string | null;
  optionLabel: string | null;
  segments: { level: "green" | "orange" | "red"; points: [number, number][] }[];
  algorithm: string | null;
  trafficMix: { green: number; orange: number; red: number } | null;
  chosenAt: string | null;
};

export type AdminLiveAmbulance = {
  id: number;
  code: string;
  type: string;
  status: string;
  lat: number;
  lng: number;
  movementSource: string;
  lastSeenAt: string | null;
  updatedSecondsAgo: number | null;
  driver: { id: number; name: string; phone: string; status: string } | null;
  mission: "to_patient" | "to_hospital" | "at_hospital" | null;
  stage: LiveStage;
  stageLabel: string;
  nextStop: { kind: "patient" | "hospital"; name: string; lat: number; lng: number } | null;
  request: {
    id: number;
    publicId: string;
    status: string;
    category: string;
    severity: string;
    patientName: string;
    pickup: { lat: number; lng: number; address: string };
    etaMinutes: number | null;
    distanceKm: number | null;
  } | null;
  hospital: { id: number; name: string; lat: number; lng: number } | null;
  hospitalSelectedAfterPickup: boolean;
  timeline: TimelineEntry[];
  route: AdminLiveRouteInfo | null;
  progress: number;
  speedKph: number;
  remainingMeters: number;
  remainingSeconds: number;
};

/** Every ambulance with its driver, trip stage, next stop, road route and live position. */
export async function getAdminLiveSnapshot() {
  await advanceActiveAmbulances().catch(() => undefined);
  const nowMs = Date.now();
  const [ambulanceRows, driverRows, hospitalRows, activeRows, tripRows, userRows] = await Promise.all([
    db.select().from(ambulances),
    db.select().from(drivers),
    db.select().from(hospitals),
    db
      .select()
      .from(emergencyRequests)
      .where(inArray(emergencyRequests.status, ["assigned", "enroute_pickup", "enroute_hospital", "arrived_hospital"])),
    db.select().from(trips),
    db.select().from(users),
  ]);
  const driverById = new Map(driverRows.map((d) => [d.id, d]));
  const emailByUser = new Map(userRows.map((u) => [u.id, u.email]));
  const hospitalById = new Map(hospitalRows.map((h) => [h.id, h]));
  const requestByAmbulance = new Map<number, RequestRow>();
  for (const row of activeRows) {
    if (row.ambulanceId) requestByAmbulance.set(row.ambulanceId, row);
  }
  const tripByRequest = new Map<number, Trip>();
  for (const trip of tripRows) {
    const previous = tripByRequest.get(trip.requestId);
    if (!previous || trip.id > previous.id) tripByRequest.set(trip.requestId, trip);
  }
  const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null);

  const entries: AdminLiveAmbulance[] = [];
  for (const a of ambulanceRows) {
    const request = requestByAmbulance.get(a.id) ?? null;
    const driver = a.driverId ? driverById.get(a.driverId) ?? null : null;
    const hospital = request?.hospitalId ? hospitalById.get(request.hospitalId) ?? null : null;
    const trip = request ? tripByRequest.get(request.id) ?? null : null;
    const mission: AdminLiveAmbulance["mission"] =
      request?.status === "assigned" || request?.status === "enroute_pickup"
        ? "to_patient"
        : request?.status === "enroute_hospital"
          ? "to_hospital"
          : request?.status === "arrived_hospital"
            ? "at_hospital"
            : null;

    let stage: LiveStage;
    let stageLabel: string;
    if (request) {
      if (request.status === "assigned") {
        stage = "assigned";
        stageLabel = "Assigned — waiting for the driver to accept";
      } else if (request.status === "enroute_pickup") {
        stage = "to_patient";
        stageLabel = `Driving to patient · ${request.patientName}`;
      } else if (request.status === "enroute_hospital") {
        stage = "to_hospital";
        stageLabel = `Patient on board · driving to ${hospital?.name ?? "hospital"}`;
      } else if (request.status === "arrived_hospital") {
        stage = "at_hospital";
        stageLabel = "Arrived at hospital — handover";
      } else {
        stage = "idle";
        stageLabel = statusLabel(request.status);
      }
    } else if (a.status === "available") {
      stage = "available";
      stageLabel = "Available at base";
    } else if (a.status === "offline") {
      stage = "offline";
      stageLabel = "Offline";
    } else {
      stage = "idle";
      stageLabel = statusLabel(a.status);
    }

    const nextStop: AdminLiveAmbulance["nextStop"] =
      stage === "to_patient" && request
        ? { kind: "patient", name: request.patientName, lat: request.pickupLat, lng: request.pickupLng }
        : stage === "to_hospital" && hospital
          ? { kind: "hospital", name: hospital.name, lat: hospital.lat, lng: hospital.lng }
          : null;

    const hospitalSelectedAfterPickup = Boolean(
      request && trip?.pickedUpAt && (request.status === "enroute_hospital" || request.status === "arrived_hospital"),
    );
    const timeline: TimelineEntry[] = trip
      ? [
          { key: "dispatched", label: "Dispatched", at: iso(trip.startedAt) },
          { key: "accepted", label: "Driver accepted", at: iso(trip.acceptedAt) },
          { key: "picked_up", label: "Patient picked up", at: iso(trip.pickedUpAt) },
          {
            key: "hospital_selected",
            label: `Nearest hospital selected: ${hospital?.name ?? "—"}`,
            at: hospitalSelectedAfterPickup ? iso(trip.pickedUpAt) : null,
          },
          { key: "arrived_hospital", label: "Arrived at hospital", at: iso(trip.arrivedHospitalAt) },
          { key: "completed", label: "Trip completed", at: iso(trip.completedAt) },
        ]
      : [];

    let route: AdminLiveAmbulance["route"] = null;
    let progress = 0;
    let speedKph = 0;
    let remainingMeters = 0;
    let remainingSeconds = 0;
    if (request && mission !== "at_hospital") {
      const latest = (
        await db.select().from(routes).where(eq(routes.requestId, request.id)).orderBy(desc(routes.id)).limit(1)
      )[0];
      if (latest && latest.geometry.length > 1) {
        const line = latest.geometry.map(([lng, lat]: [number, number]) => ({ lat, lng }));
        const total = polylineLength(line);
        progress = total > 0 ? Math.min(1, projectOnPolyline({ lat: a.lat, lng: a.lng }, line).alongMeters / total) : 0;
        const duration = Math.max(60, latest.durationSeconds);
        speedKph = total > 0 ? (total / duration) * 3.6 : 0;
        remainingMeters = total * (1 - progress);
        remainingSeconds = latest.durationSeconds * (1 - progress);
        const summary = (latest.trafficSummary ?? {}) as {
          key?: string;
          label?: string;
          segments?: AdminLiveRouteInfo["segments"];
          algorithm?: string;
          trafficMix?: AdminLiveRouteInfo["trafficMix"];
          chosenAt?: string;
        };
        route = {
          id: latest.id,
          purpose: mission === "to_hospital" ? "hospital" : "pickup",
          geometry: latest.geometry,
          durationSeconds: latest.durationSeconds,
          distanceMeters: latest.distanceMeters,
          createdAt: new Date(latest.createdAt).toISOString(),
          engine: summary.key ? "osm-graph" : "osrm",
          optionKey: summary.key ?? null,
          optionLabel: summary.label ?? null,
          segments: summary.segments ?? [],
          algorithm: summary.algorithm ?? null,
          trafficMix: summary.trafficMix ?? null,
          chosenAt: summary.chosenAt ?? null,
        };
      }
    }

    entries.push({
      id: a.id,
      code: a.code,
      type: a.type,
      status: a.status,
      lat: a.lat,
      lng: a.lng,
      movementSource: a.movementSource ?? "engine",
      lastSeenAt: iso(a.lastSeenAt),
      updatedSecondsAgo: a.lastSeenAt ? Math.max(0, Math.round((nowMs - new Date(a.lastSeenAt).getTime()) / 1000)) : null,
      driver: driver ? { id: driver.id, name: driver.name, phone: driver.phone, status: driver.status } : null,
      mission,
      stage,
      stageLabel,
      nextStop,
      request: request
        ? {
            id: request.id,
            publicId: request.publicId,
            status: request.status,
            category: request.category,
            severity: request.severity,
            patientName: request.patientName,
            pickup: { lat: request.pickupLat, lng: request.pickupLng, address: request.pickupAddress },
            etaMinutes: request.etaMinutes,
            distanceKm: request.distanceKm,
          }
        : null,
      hospital: hospital ? { id: hospital.id, name: hospital.name, lat: hospital.lat, lng: hospital.lng } : null,
      hospitalSelectedAfterPickup,
      timeline,
      route,
      progress,
      speedKph,
      remainingMeters,
      remainingSeconds,
    });
  }

  // Every registered driver, with login, device GPS and the live stage of their ambulance.
  const entryByDriver = new Map<number, AdminLiveAmbulance>();
  for (const entry of entries) if (entry.driver) entryByDriver.set(entry.driver.id, entry);
  const driverList: DriverListItem[] = driverRows
    .map((d) => {
      const entry = entryByDriver.get(d.id) ?? null;
      const vehicle = d.ambulanceId ? ambulanceRows.find((a) => a.id === d.ambulanceId) ?? null : null;
      const stage = entry?.stage ?? (vehicle?.status === "offline" ? "offline" : "available");
      return {
        id: d.id,
        name: d.name,
        phone: d.phone,
        licenseNo: d.licenseNo,
        status: d.status,
        loginEmail: d.userId ? emailByUser.get(d.userId) ?? null : null,
        ambulanceId: d.ambulanceId,
        ambulanceCode: vehicle?.code ?? null,
        deviceLat: d.lat,
        deviceLng: d.lng,
        deviceUpdatedSecondsAgo: d.lastSeenAt ? Math.max(0, Math.round((nowMs - new Date(d.lastSeenAt).getTime()) / 1000)) : null,
        stage,
        stageLabel: entry?.stageLabel ?? (stage === "offline" ? "Offline" : "Available at base"),
        requestPublicId: entry?.request?.publicId ?? null,
      };
    })
    .sort((a, b) => {
      const rank = (x: DriverListItem) => (x.stage === "to_patient" || x.stage === "to_hospital" || x.stage === "at_hospital" || x.stage === "assigned" ? 0 : x.status === "offline" ? 2 : 1);
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    drivers: driverList,
    summary: {
      total: entries.length,
      moving: entries.filter((e) => e.route).length,
      toPatient: entries.filter((e) => e.stage === "to_patient").length,
      toHospital: entries.filter((e) => e.stage === "to_hospital").length,
      atHospital: entries.filter((e) => e.stage === "at_hospital").length,
      available: entries.filter((e) => e.status === "available").length,
      offline: entries.filter((e) => e.status === "offline").length,
    },
    ambulances: entries,
    hospitals: hospitalRows.map((h) => ({ id: h.id, name: h.name, lat: h.lat, lng: h.lng })),
  };
}

export type RequestDetail = {
  request: RequestRow;
  hospital: HospitalRow | null;
  preferredHospital: HospitalRow | null;
  ambulance: AmbulanceRow | null;
  driver: Driver | null;
  trip: Trip | null;
  route: RouteRow | null;
  plan: RoutePlan | null;
  disruptions: RoadDisruption[];
  candidates: { hospitalId: number; name: string; durationSeconds: number; suitability: number }[];
  ambulanceProgress: number;
  routeDurationSeconds: number | null;
  ambulanceUpdatedAt: string | null;
};

export async function getRequestDetail(idOrPublicId: string | number): Promise<RequestDetail | null> {
  await advanceActiveAmbulances().catch(() => undefined);
  const numeric = typeof idOrPublicId === "number" ? idOrPublicId : Number(idOrPublicId);
  const rows = await db
    .select()
    .from(emergencyRequests)
    .where(
      Number.isFinite(numeric) && String(numeric) === String(idOrPublicId)
        ? eq(emergencyRequests.id, numeric)
        : eq(emergencyRequests.publicId, String(idOrPublicId)),
    )
    .limit(1);
  const request = rows[0];
  if (!request) return null;

  const [hospitalRows, preferredRows, ambulanceRows, driverRows, trip, routeRows, disruptionRows] = await Promise.all([
    request.hospitalId
      ? db.select().from(hospitals).where(eq(hospitals.id, request.hospitalId)).limit(1)
      : Promise.resolve([]),
    request.preferredHospitalId
      ? db.select().from(hospitals).where(eq(hospitals.id, request.preferredHospitalId)).limit(1)
      : Promise.resolve([]),
    request.ambulanceId
      ? db.select().from(ambulances).where(eq(ambulances.id, request.ambulanceId)).limit(1)
      : Promise.resolve([]),
    request.driverId ? db.select().from(drivers).where(eq(drivers.id, request.driverId)).limit(1) : Promise.resolve([]),
    loadTripForRequest(request.id),
    db.select().from(routes).where(eq(routes.requestId, request.id)).orderBy(desc(routes.id)).limit(1),
    db.select().from(roadDisruptions).where(eq(roadDisruptions.status, "active")),
  ]);

  const hospital = hospitalRows[0] ?? null;
  const ambulance = ambulanceRows[0] ?? null;
  const latestRoute = routeRows[0] ?? null;

  let plan: RoutePlan | null = null;
  if (latestRoute) {
    const origin = { lat: latestRoute.origin[1], lng: latestRoute.origin[0] };
    const destination = { lat: latestRoute.destination[1], lng: latestRoute.destination[0] };
    plan = presentRoutePlan(await planFor(origin, destination, 3), latestRoute);
  }

  const candidates: RequestDetail["candidates"] = [];

  const ambulanceProgress =
    ambulance && latestRoute
      ? projectProgress({ lat: ambulance.lat, lng: ambulance.lng }, latestRoute.geometry.map(([lng, lat]: [number, number]) => ({ lat, lng })))
      : 0;

  return {
    request,
    hospital,
    preferredHospital: preferredRows[0] ?? null,
    ambulance,
    driver: driverRows[0] ?? null,
    trip,
    route: latestRoute,
    plan,
    disruptions: disruptionRows,
    candidates,
    ambulanceProgress,
    routeDurationSeconds: latestRoute?.durationSeconds ?? null,
    ambulanceUpdatedAt: ambulance?.lastSeenAt ? new Date(ambulance.lastSeenAt).toISOString() : null,
  };
}

export type LiveSnapshot = {
  generatedAt: string;
  ambulances: {
    id: number;
    code: string;
    type: string;
    status: string;
    lat: number;
    lng: number;
    driverName: string | null;
    hospitalId: number | null;
  }[];
  requests: {
    id: number;
    publicId: string;
    status: string;
    category: string;
    severity: string;
    etaMinutes: number | null;
    ambulanceId: number | null;
    hospitalId: number | null;
    pickupLat: number;
    pickupLng: number;
    createdAt: string;
  }[];
  disruptions: {
    id: number;
    title: string;
    type: string;
    severity: string;
    status: string;
    lat: number;
    lng: number;
    roadName: string | null;
  }[];
  trips: {
    id: number;
    requestId: number;
    status: string;
    ambulanceId: number;
    driverId: number;
  }[];
};

export async function getLiveSnapshot(): Promise<LiveSnapshot> {
  await advanceActiveAmbulances().catch(() => undefined);
  const [ambulanceRows, requestRows, disruptionRows, tripRows] = await Promise.all([
    db.select().from(ambulances),
    db.select().from(emergencyRequests).orderBy(desc(emergencyRequests.id)).limit(40),
    db.select().from(roadDisruptions).where(eq(roadDisruptions.status, "active")),
    db.select().from(trips).where(inArray(trips.status, ["to_pickup", "at_pickup", "to_hospital"])),
  ]);
  const driverRows = await db.select().from(drivers);
  const driverById = new Map(driverRows.map((d) => [d.id, d]));
  const segmentRows = disruptionRows.length
    ? await db.select().from(roadSegments).where(inArray(roadSegments.id, disruptionRows.map((d) => d.segmentId).filter((v): v is number => v !== null)))
    : [];
  const segmentById = new Map(segmentRows.map((s) => [s.id, s]));

  return {
    generatedAt: new Date().toISOString(),
    ambulances: ambulanceRows.map((a) => ({
      id: a.id,
      code: a.code,
      type: a.type,
      status: a.status,
      lat: a.lat,
      lng: a.lng,
      driverName: a.driverId ? driverById.get(a.driverId)?.name ?? null : null,
      hospitalId: a.hospitalId,
    })),
    requests: requestRows.map((r) => ({
      id: r.id,
      publicId: r.publicId,
      status: r.status,
      category: r.category,
      severity: r.severity,
      etaMinutes: r.etaMinutes,
      ambulanceId: r.ambulanceId,
      hospitalId: r.hospitalId,
      pickupLat: r.pickupLat,
      pickupLng: r.pickupLng,
      createdAt: r.createdAt.toISOString(),
    })),
    disruptions: disruptionRows.map((d) => ({
      id: d.id,
      title: d.title,
      type: d.type,
      severity: d.severity,
      status: d.status,
      lat: d.lat,
      lng: d.lng,
      roadName: d.segmentId ? segmentById.get(d.segmentId)?.roadName ?? null : null,
    })),
    trips: tripRows.map((t) => ({
      id: t.id,
      requestId: t.requestId,
      status: t.status,
      ambulanceId: t.ambulanceId,
      driverId: t.driverId,
    })),
  };
}

export async function getDriverContext(driverId: number) {
  const driverRows = await db.select().from(drivers).where(eq(drivers.id, driverId)).limit(1);
  const driver = driverRows[0];
  if (!driver) return null;
  const ambulanceRows = driver.ambulanceId
    ? await db.select().from(ambulances).where(eq(ambulances.id, driver.ambulanceId)).limit(1)
    : [];
  const ambulance = ambulanceRows[0] ?? null;
  const activeRequests = await db
    .select()
    .from(emergencyRequests)
    .where(and(eq(emergencyRequests.driverId, driverId), inArray(emergencyRequests.status, ["assigned", "enroute_pickup", "arrived_pickup", "enroute_hospital", "arrived_hospital"])))
    .orderBy(desc(emergencyRequests.id));
  const request = activeRequests[0] ?? null;
  const hospitalRows = request?.hospitalId
    ? await db.select().from(hospitals).where(eq(hospitals.id, request.hospitalId)).limit(1)
    : [];
  const trip = request ? await loadTripForRequest(request.id) : null;
  const routeRows = request
    ? await db.select().from(routes).where(eq(routes.requestId, request.id)).orderBy(desc(routes.id)).limit(1)
    : [];
  const disruptionRows = await db.select().from(roadDisruptions).where(eq(roadDisruptions.status, "active"));
  const reroute = request ? await latestRerouteForRequest(request.id) : null;
  const latestRoute = routeRows[0] ?? null;
  const ambulanceProgress =
    ambulance && latestRoute
      ? projectProgress({ lat: ambulance.lat, lng: ambulance.lng }, latestRoute.geometry.map(([lng, lat]: [number, number]) => ({ lat, lng })))
      : 0;
  return {
    driver,
    ambulance,
    request,
    hospital: hospitalRows[0] ?? null,
    trip,
    route: latestRoute,
    disruptions: disruptionRows,
    reroute,
    ambulanceProgress,
    routeDurationSeconds: latestRoute?.durationSeconds ?? null,
    ambulanceUpdatedAt: ambulance?.lastSeenAt ? new Date(ambulance.lastSeenAt).toISOString() : null,
  };
}

export async function getAdminStats() {
  const [requestRows, ambulanceRows, hospitalRows, driverRows, tripRows, disruptionRows, routeRows] = await Promise.all([
    db.select().from(emergencyRequests),
    db.select().from(ambulances),
    db.select().from(hospitals),
    db.select().from(drivers),
    db.select().from(trips),
    db.select().from(roadDisruptions).where(eq(roadDisruptions.status, "active")),
    db.select().from(routes).orderBy(desc(routes.id)).limit(25),
  ]);

  return {
    totals: {
      requests: requestRows.length,
      activeRequests: requestRows.filter((r) => !["completed", "cancelled"].includes(r.status)).length,
      ambulances: ambulanceRows.length,
      available: ambulanceRows.filter((a) => a.status === "available").length,
      busy: ambulanceRows.filter((a) => a.status === "on_trip" || a.status === "assigned").length,
      offline: ambulanceRows.filter((a) => a.status === "offline").length,
      hospitals: hospitalRows.length,
      drivers: driverRows.length,
      driversOnline: driverRows.filter((d) => d.status === "online" || d.status === "on_trip").length,
      ongoingTrips: tripRows.filter((t) => ["to_pickup", "at_pickup", "to_hospital"].includes(t.status)).length,
      disruptions: disruptionRows.length,
      completedTrips: tripRows.filter((t) => t.status === "completed").length,
    },
    recentRequests: requestRows
      .sort((a, b) => b.id - a.id)
      .slice(0, 12)
      .map((r) => ({
        id: r.id,
        publicId: r.publicId,
        patientName: r.patientName,
        category: r.category,
        severity: r.severity,
        status: r.status,
        mode: r.mode,
        etaMinutes: r.etaMinutes,
        distanceKm: r.distanceKm,
        ambulanceId: r.ambulanceId,
        hospitalId: r.hospitalId,
        createdAt: r.createdAt.toISOString(),
      })),
    ambulances: ambulanceRows,
    hospitals: hospitalRows,
    drivers: driverRows,
    trips: tripRows.sort((a, b) => b.id - a.id).slice(0, 20),
    disruptions: disruptionRows,
    routes: routeRows.map((r) => ({
      id: r.id,
      requestId: r.requestId,
      mode: r.mode,
      distanceMeters: r.distanceMeters,
      durationSeconds: r.durationSeconds,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export async function resolveDisruption(id: number): Promise<void> {
  await db
    .update(roadDisruptions)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(eq(roadDisruptions.id, id));
  await notify({
    role: "admin",
    type: "disruption_resolved",
    title: `Disruption #${id} resolved`,
    body: "Routes will be recalculated on next dispatch check",
  });
}

export async function refreshRoutesForActiveTrips(): Promise<number> {
  const activeRequests = await db
    .select()
    .from(emergencyRequests)
    .where(inArray(emergencyRequests.status, ["enroute_pickup", "enroute_hospital"]));
  let updated = 0;
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
    // Continue from where the unit is now — never from the patient's pickup point.
    const start = ambulance ? { lat: ambulance.lat, lng: ambulance.lng } : { lat: request.pickupLat, lng: request.pickupLng };
    const plan = await planFor(start, { lat: hospital.lat, lng: hospital.lng }, 3);
    const option = plan.fastest;
    if (!option) continue;
    await db.insert(routes).values({
      requestId: request.id,
      mode: "recalculate",
      origin: [start.lng, start.lat],
      destination: [hospital.lng, hospital.lat],
      geometry: option.geometry,
      distanceMeters: option.distanceMeters,
      durationSeconds: option.durationSeconds,
      alternatives: plan.options.slice(1),
      disruptions: option.disruptions,
      trafficSummary: { level: option.traffic, delaySeconds: option.delaySeconds },
    });
    await db
      .update(emergencyRequests)
      .set({
        etaMinutes: Math.max(1, Math.round(option.durationSeconds / 60)),
        distanceKm: Number((option.distanceMeters / 1000).toFixed(2)),
        updatedAt: new Date(),
      })
      .where(eq(emergencyRequests.id, request.id));
    updated += 1;
  }
  return updated;
}

export async function findNearestSegment(point: LatLng) {
  const segments = await db.select().from(roadSegments);
  let best: { segment: RoadSegment; distance: number } | null = null;
  for (const segment of segments) {
    for (const [lng, lat] of segment.geometry as [number, number][]) {
      const d = haversine(point, { lat, lng });
      if (!best || d < best.distance) best = { segment, distance: d };
    }
  }
  return best;
}

export async function listActiveDisruptionsWithRoad() {
  const rows = await db.select().from(roadDisruptions).where(eq(roadDisruptions.status, "active")).orderBy(desc(roadDisruptions.id));
  const segmentRows = await db.select().from(roadSegments);
  const segmentById = new Map(segmentRows.map((s) => [s.id, s]));
  return rows.map((d) => ({
    ...(d as unknown as RoadDisruption),
    roadName: d.segmentId ? segmentById.get(d.segmentId)?.roadName ?? null : null,
  }));
}

export async function countPendingAssignmentsForDriver(driverId: number) {
  const rows = await db
    .select({ id: ambulanceAssignments.id })
    .from(ambulanceAssignments)
    .where(and(eq(ambulanceAssignments.driverId, driverId), eq(ambulanceAssignments.status, "pending")));
  return rows.length;
}

export async function releaseAmbulance(ambulanceId: number) {
  await db.update(ambulances).set({ status: "available" }).where(eq(ambulances.id, ambulanceId));
}

export async function setAmbulanceStatus(ambulanceId: number, status: string) {
  await db.update(ambulances).set({ status }).where(eq(ambulances.id, ambulanceId));
}

export async function setDriverStatus(driverId: number, status: string) {
  await db.update(drivers).set({ status, lastSeenAt: new Date() }).where(eq(drivers.id, driverId));
}

/** The leg a trip is on now, with the origin (ambulance position) and destination. */
export async function resolveLeg(requestId: number) {
  const request = await loadRequestOrThrow(requestId);
  const ambulance = request.ambulanceId
    ? (await db.select().from(ambulances).where(eq(ambulances.id, request.ambulanceId)).limit(1))[0] ?? null
    : null;
  const hospital = request.hospitalId
    ? ((await db.select().from(hospitals).where(eq(hospitals.id, request.hospitalId)).limit(1))[0] as unknown as Hospital | undefined) ?? null
    : null;
  const pickup = { lat: request.pickupLat, lng: request.pickupLng };
  const onHospitalLeg = request.status === "enroute_hospital" || request.status === "arrived_hospital";
  const origin = ambulance ? { lat: ambulance.lat, lng: ambulance.lng } : pickup;
  const destination = onHospitalLeg ? (hospital ? { lat: hospital.lat, lng: hospital.lng } : null) : pickup;
  return { request, ambulance, hospital, origin, destination, leg: onHospitalLeg ? ("hospital" as const) : ("pickup" as const) };
}

/**
 * The driver chooses one of the three route options for the current leg. The chosen route becomes
 * the active route: the ambulance drives it, and the patient, admin and tracking views show it.
 */
export async function selectRouteOption(params: { requestId: number; driverId: number; option: string }) {
  if (!isOptionKey(params.option) && !/^alt\d+$/.test(params.option)) {
    throw new HttpError(400, "Choose fastest, fast or slow");
  }
  const leg = await resolveLeg(params.requestId);
  if (leg.request.driverId !== params.driverId) throw new HttpError(403, "This trip is assigned to another driver");
  if (!["assigned", "enroute_pickup", "enroute_hospital"].includes(leg.request.status)) {
    throw new HttpError(409, "Route options are only available during an active trip");
  }
  if (!leg.destination) throw new HttpError(409, "This trip has no destination");

  const [segments, disruptions] = await Promise.all([loadSegments(), loadDisruptions()]);
  const plan = await planRoadRoute({
    origin: leg.origin,
    destination: leg.destination,
    segments,
    disruptions,
    alternatives: 3,
  });
  const chosen = plan.options.find((o) => o.key === params.option);
  if (!chosen) throw new HttpError(404, "That route is not available right now. Refresh the options and try again.");

  const now = new Date();
  const etaMinutes = Math.max(1, Math.round(chosen.durationSeconds / 60));
  const destination = leg.destination;
  await db.insert(routes).values({
    requestId: params.requestId,
    mode: `option:${chosen.key}`,
    origin: [leg.origin.lng, leg.origin.lat],
    destination: [destination.lng, destination.lat],
    geometry: chosen.geometry,
    distanceMeters: chosen.distanceMeters,
    durationSeconds: chosen.durationSeconds,
    alternatives: plan.options
      .filter((o) => o.key !== chosen.key)
      .map((o) => ({
        key: o.key,
        label: o.label,
        durationSeconds: o.durationSeconds,
        distanceMeters: o.distanceMeters,
        delaySeconds: o.delaySeconds,
        traffic: o.traffic,
        algorithm: o.algorithm,
      })),
    disruptions: chosen.disruptions,
    trafficSummary: {
      level: chosen.traffic,
      delaySeconds: chosen.delaySeconds,
      key: chosen.key,
      label: chosen.label,
      algorithm: chosen.algorithm,
      overlapWithFastest: chosen.overlapWithFastest,
      trafficMix: chosen.trafficMix,
      nodesExpanded: chosen.nodesExpanded,
      computeMs: chosen.computeMs,
      segments: chosen.segments ?? [],
      steps: chosen.steps ?? [],
      leg: leg.leg,
      chosenAt: now.toISOString(),
    },
  });

  await db
    .update(emergencyRequests)
    .set({ etaMinutes, distanceKm: Number((chosen.distanceMeters / 1000).toFixed(2)), updatedAt: now })
    .where(eq(emergencyRequests.id, params.requestId));

  await notify({
    role: "admin",
    requestId: params.requestId,
    type: "route_selected",
    title: `${chosen.label} route selected · ${leg.request.publicId}`,
    body: `${leg.leg === "pickup" ? "To patient" : "To hospital"} · ${etaMinutes} min, ${(chosen.distanceMeters / 1000).toFixed(1)} km · ${chosen.algorithm ?? ""}`,
  });

  return {
    option: {
      key: chosen.key,
      label: chosen.label,
      durationSeconds: chosen.durationSeconds,
      distanceMeters: chosen.distanceMeters,
      delaySeconds: chosen.delaySeconds,
      traffic: chosen.traffic,
    },
    leg: leg.leg,
    etaMinutes,
  };
}

/** The route stored for a request's current leg (the one the ambulance drives). */
export async function latestRouteFor(requestId: number): Promise<RouteRow | null> {
  const rows = await db.select().from(routes).where(eq(routes.requestId, requestId)).orderBy(desc(routes.id)).limit(1);
  return (rows[0] as RouteRow | undefined) ?? null;
}

/** Which option a stored route corresponds to: fastest, fast or slow (fastest when unknown). */
export function routeKeyOf(stored: RouteRow): string {
  const summary = (stored.trafficSummary ?? {}) as { key?: string };
  if (summary.key) return summary.key;
  if (stored.mode.startsWith("option:")) return stored.mode.slice("option:".length);
  return "fastest";
}

const OPTION_NAMES: Record<string, string> = { fastest: "Fastest", fast: "Little fast", slow: "Slow alternative" };

/**
 * Presents a freshly computed plan for a request with the route the ambulance is actually driving:
 * that route is listed first (with its stored geometry, steps and traffic), and the other options
 * follow as alternatives. The map therefore shows the selected route in green and the alternates
 * beside it, never a different "fastest" route.
 */
export function presentRoutePlan(plan: RoutePlan, stored: RouteRow | null): RoutePlan {
  if (!stored || stored.geometry.length < 2) return plan;
  const key = routeKeyOf(stored);
  const base = plan.options.find((o) => o.key === key) ?? plan.fastest ?? plan.options[0];
  if (!base) return plan;
  const summary = (stored.trafficSummary ?? {}) as {
    steps?: RouteOption["steps"];
    segments?: RouteOption["segments"];
    trafficMix?: RouteOption["trafficMix"];
    algorithm?: string;
  };
  const driven: RouteOption = {
    ...base,
    key,
    label: OPTION_NAMES[key] ?? base.label,
    geometry: stored.geometry,
    distanceMeters: stored.distanceMeters,
    durationSeconds: stored.durationSeconds,
    steps: summary.steps?.length ? summary.steps : base.steps,
    segments: summary.segments?.length ? summary.segments : base.segments,
    trafficMix: summary.trafficMix ?? base.trafficMix,
    algorithm: summary.algorithm ?? base.algorithm,
  };
  const alternatives = plan.options.filter((o) => o.key !== key);
  return { ...plan, options: [driven, ...alternatives], fastest: driven };
}
