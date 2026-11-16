/**
 * Full profile of one driver for the admin control room: identity, login, vehicle, live position
 * and stage, current trip, assignment log, trip history and totals. Server-only.
 */
import { desc, eq, inArray } from "@/db";
import { db } from "@/db";
import {
  ambulanceAssignments,
  drivers,
  emergencyRequests,
  hospitals,
  trips,
  users,
  ambulances,
} from "@/db/schema";
import { getAdminLiveSnapshot } from "@/lib/dispatch";
import type { DriverProfile } from "@/lib/driverProfileTypes";

const HISTORY_LIMIT = 12;

const ageSeconds = (value: Date | string | null | undefined, now: number): number | null =>
  value ? Math.max(0, Math.round((now - new Date(value).getTime()) / 1000)) : null;

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

/** Returns null when no driver has this id. */
export async function getDriverProfile(driverId: number): Promise<DriverProfile | null> {
  const now = Date.now();
  const driverRows = await db.select().from(drivers).where(eq(drivers.id, driverId)).limit(1);
  const driver = driverRows[0];
  if (!driver) return null;

  const [snapshot, userRows, vehicleRows, assignmentRows, tripRows] = await Promise.all([
    getAdminLiveSnapshot(),
    driver.userId ? db.select().from(users).where(eq(users.id, driver.userId)).limit(1) : Promise.resolve([]),
    driver.ambulanceId ? db.select().from(ambulances).where(eq(ambulances.id, driver.ambulanceId)).limit(1) : Promise.resolve([]),
    db.select().from(ambulanceAssignments).where(eq(ambulanceAssignments.driverId, driverId)).orderBy(desc(ambulanceAssignments.id)),
    db.select().from(trips).where(eq(trips.driverId, driverId)).orderBy(desc(trips.id)),
  ]);

  const user = userRows[0] ?? null;
  const vehicle = vehicleRows[0] ?? null;
  const entry = snapshot.ambulances.find((a) => a.driver?.id === driverId) ?? null;
  const ambulanceRow = vehicle ?? null;
  const baseRows = ambulanceRow?.hospitalId
    ? await db.select().from(hospitals).where(eq(hospitals.id, ambulanceRow.hospitalId)).limit(1)
    : [];
  const base = baseRows[0] ?? null;

  // Requests behind the recent trips and assignments (one query).
  const recentTrips = tripRows.slice(0, HISTORY_LIMIT);
  const recentAssignments = assignmentRows.slice(0, HISTORY_LIMIT);
  const requestIds = [...new Set([...recentTrips, ...recentAssignments].map((row) => row.requestId))];
  const requestRows = requestIds.length
    ? await db.select().from(emergencyRequests).where(inArray(emergencyRequests.id, requestIds))
    : [];
  const requestById = new Map(requestRows.map((r) => [r.id, r]));

  const currentRequest = entry?.request ? requestById.get(entry.request.id) ?? null : null;
  const currentHospital = entry?.hospital ? entry.hospital : null;
  const hospitalDetail = currentHospital
    ? ((await db.select().from(hospitals).where(eq(hospitals.id, currentHospital.id)).limit(1))[0] ?? null)
    : null;

  const completed = tripRows.filter((t) => t.status === "completed");
  const active = tripRows.filter((t) => ["to_pickup", "at_pickup", "to_hospital"].includes(t.status));

  return {
    generatedAt: new Date(now).toISOString(),
    driver: {
      id: driver.id,
      name: driver.name,
      phone: driver.phone,
      licenseNo: driver.licenseNo,
      status: driver.status,
      createdAt: new Date(driver.createdAt).toISOString(),
      lastSeenAt: iso(driver.lastSeenAt),
    },
    login: {
      email: user?.email ?? null,
      username: user?.email ? user.email.split("@")[0] : null,
      role: user?.role ?? null,
    },
    vehicle: vehicle
      ? {
          id: vehicle.id,
          code: vehicle.code,
          type: vehicle.type,
          status: vehicle.status,
          facilities: vehicle.facilities ?? [],
          base: base ? { id: base.id, name: base.name, lat: base.lat, lng: base.lng } : null,
        }
      : null,
    position: {
      ambulance: entry
        ? {
            lat: entry.lat,
            lng: entry.lng,
            source: entry.movementSource,
            updatedSecondsAgo: entry.updatedSecondsAgo,
          }
        : null,
      device:
        driver.lat !== null && driver.lng !== null
          ? { lat: driver.lat, lng: driver.lng, updatedSecondsAgo: ageSeconds(driver.lastSeenAt, now) }
          : null,
    },
    live: {
      stage: entry?.stage ?? (vehicle?.status === "offline" ? "offline" : "available"),
      stageLabel: entry?.stageLabel ?? (vehicle?.status === "offline" ? "Offline" : "Available at base"),
      speedKph: entry?.speedKph ?? 0,
      progress: entry?.progress ?? 0,
      remainingMeters: entry?.remainingMeters ?? 0,
      remainingSeconds: entry?.remainingSeconds ?? 0,
      nextStop: entry?.nextStop ?? null,
      route: entry?.route
        ? {
            purpose: entry.route.purpose,
            optionKey: entry.route.optionKey,
            optionLabel: entry.route.optionLabel,
            algorithm: entry.route.algorithm,
            engine: entry.route.engine,
            distanceMeters: entry.route.distanceMeters,
            durationSeconds: entry.route.durationSeconds,
            trafficMix: entry.route.trafficMix,
            chosenAt: entry.route.chosenAt ?? entry.route.createdAt,
          }
        : null,
    },
    currentTrip:
      entry?.request && currentRequest
        ? {
            requestId: entry.request.id,
            publicId: entry.request.publicId,
            status: entry.request.status,
            category: entry.request.category,
            severity: entry.request.severity,
            startedAt: iso(currentRequest.createdAt),
            patient: { name: currentRequest.patientName, phone: currentRequest.patientPhone },
            pickup: {
              lat: currentRequest.pickupLat,
              lng: currentRequest.pickupLng,
              address: currentRequest.pickupAddress,
            },
            hospital: hospitalDetail
              ? {
                  id: hospitalDetail.id,
                  name: hospitalDetail.name,
                  address: hospitalDetail.address,
                  phone: hospitalDetail.phone,
                  lat: hospitalDetail.lat,
                  lng: hospitalDetail.lng,
                }
              : null,
            etaMinutes: currentRequest.etaMinutes,
            distanceKm: currentRequest.distanceKm,
            timeline: entry.timeline,
          }
        : null,
    assignments: recentAssignments.map((a) => {
      const request = requestById.get(a.requestId);
      return {
        id: a.id,
        requestId: a.requestId,
        publicId: request?.publicId ?? `#${a.requestId}`,
        status: a.status,
        reason: a.reason,
        createdAt: new Date(a.createdAt).toISOString(),
        respondedAt: iso(a.respondedAt),
      };
    }),
    trips: recentTrips.map((t) => {
      const request = requestById.get(t.requestId);
      return {
        id: t.id,
        requestId: t.requestId,
        publicId: request?.publicId ?? `#${t.requestId}`,
        patientName: request?.patientName ?? "—",
        category: request?.category ?? "other",
        status: t.status,
        startedAt: new Date(t.startedAt).toISOString(),
        completedAt: iso(t.completedAt),
        distanceKm: Number(t.distanceKm.toFixed(2)),
        durationSeconds: t.durationSeconds,
      };
    }),
    stats: {
      completedTrips: completed.length,
      activeTrips: active.length,
      totalDistanceKm: Number(completed.reduce((sum, t) => sum + t.distanceKm, 0).toFixed(1)),
      pickups: tripRows.filter((t) => t.pickedUpAt).length,
      assignmentsAccepted: assignmentRows.filter((a) => a.status === "accepted").length,
      assignmentsRejected: assignmentRows.filter((a) => a.status === "rejected").length,
    },
  };
}
