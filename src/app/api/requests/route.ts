import { desc } from "@/db";
import { db } from "@/db";
import { emergencyRequests } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import {
  ok,
  optionalString,
  readJson,
  requireEnum,
  requireLat,
  requireLng,
  requireString,
  route,
} from "@/lib/api";
import { EMERGENCY_CATEGORIES, SEVERITIES } from "@/lib/domain";
import { createEmergencyRequest } from "@/lib/dispatch";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireUser(["admin"]);
  const rows = await db.select().from(emergencyRequests).orderBy(desc(emergencyRequests.id)).limit(100);
  return ok({ requests: rows });
});

export const POST = route(async (request: Request) => {
  await ensureSeeded();
  const body = await readJson(request);
  const channel = body.channel === "control_room" ? "control_room" : "app";
  if (channel === "control_room") await requireUser(["admin"]);
  const patientName = requireString(body.patientName, "patient name", 120);
  const patientPhone = requireString(body.patientPhone, "contact number", 40);
  if (!/^[0-9]{10}$/.test(patientPhone)) {
    throw new HttpError(400, "Contact number must contain exactly 10 digits");
  }
  const category = requireEnum(body.category, EMERGENCY_CATEGORIES.map((c) => c.value), "emergency category");
  const severity = requireEnum(body.severity ?? "serious", SEVERITIES, "severity");
  const mode = requireEnum(body.mode ?? "nearest", ["nearest", "desired"] as const, "mode");
  const lat = requireLat(body.lat, "pickup latitude");
  const lng = requireLng(body.lng, "pickup longitude");

  const result = await createEmergencyRequest({
    patientName,
    patientPhone,
    category,
    severity,
    mode,
    pickup: { lat, lng },
    pickupAddress: optionalString(body.pickupAddress, 300),
    preferredHospitalId: body.preferredHospitalId ? Number(body.preferredHospitalId) : null,
    notes: optionalString(body.notes, 1000),
    channel,
  });

  return ok(
    {
      ambulanceCandidates: result.ambulanceCandidates,
      request: result.request,
      hospital: result.hospital,
      candidates: result.candidates.map((c) => ({
        hospitalId: c.hospital.id,
        name: c.hospital.name,
        durationSeconds: c.durationSeconds,
        distanceMeters: c.distanceMeters,
        suitability: c.suitability,
        missing: c.missing,
      })),
      assignment: result.assignment
        ? {
            ambulance: result.assignment.ambulance,
            driver: result.assignment.driver,
            route: result.assignment.route,
          }
        : null,
    },
    201,
  );
});
