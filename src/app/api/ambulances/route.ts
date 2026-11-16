import { asc, eq } from "@/db";
import { db } from "@/db";
import { ambulances } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { ok, optionalString, readJson, requireEnum, requireLat, requireLng, requireString, route } from "@/lib/api";
import { geohash } from "@/lib/geo";
import { AMBULANCE_STATUSES, AMBULANCE_TYPES } from "@/lib/domain";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await ensureSeeded();
  const rows = await db.select().from(ambulances).orderBy(asc(ambulances.code));
  return ok({ ambulances: rows });
});

export const POST = route(async (request: Request) => {
  await requireUser(["admin"]);
  const body = await readJson(request);
  const code = requireString(body.code, "code", 40);
  const existing = await db.select({ id: ambulances.id }).from(ambulances).where(eq(ambulances.code, code)).limit(1);
  if (existing.length > 0) throw new HttpError(409, "Ambulance code already exists");
  const lat = requireLat(body.lat);
  const lng = requireLng(body.lng);
  const inserted = await db
    .insert(ambulances)
    .values({
      code,
      type: requireEnum(body.type ?? "BLS", AMBULANCE_TYPES, "type"),
      status: requireEnum(body.status ?? "available", AMBULANCE_STATUSES, "status"),
      lat,
      lng,
      geohash: geohash(lat, lng),
      driverId: body.driverId ? Number(body.driverId) : null,
      hospitalId: body.hospitalId ? Number(body.hospitalId) : null,
      facilities: Array.isArray(body.facilities) ? body.facilities.filter((f): f is string => typeof f === "string") : [],
      lastSeenAt: new Date(),
    })
    .returning();
  return ok({ ambulance: inserted[0] }, 201);
});

export const PATCH = route(async (request: Request) => {
  const user = await requireUser(["admin", "driver"]);
  const body = await readJson(request);
  const id = Number(body.id);
  if (!Number.isFinite(id)) throw new HttpError(400, "Ambulance id is required");

  const existingRows = await db.select().from(ambulances).where(eq(ambulances.id, id)).limit(1);
  const existing = existingRows[0];
  if (!existing) throw new HttpError(404, "Ambulance not found");

  const patch: Record<string, unknown> = { lastSeenAt: new Date() };
  if (typeof body.status === "string") patch.status = requireEnum(body.status, AMBULANCE_STATUSES, "status");
  if (body.lat !== undefined) {
    const lat = requireLat(body.lat);
    patch.lat = lat;
    patch.geohash = geohash(lat, body.lng !== undefined ? requireLng(body.lng) : existing.lng);
  }
  if (body.lng !== undefined) patch.lng = requireLng(body.lng);
  if (body.driverId !== undefined) patch.driverId = body.driverId ? Number(body.driverId) : null;
  if (body.hospitalId !== undefined) patch.hospitalId = body.hospitalId ? Number(body.hospitalId) : null;
  if (typeof body.type === "string") patch.type = requireEnum(body.type, AMBULANCE_TYPES, "type");
  if (typeof body.code === "string") patch.code = optionalString(body.code, 40);

  const updated = await db.update(ambulances).set(patch).where(eq(ambulances.id, id)).returning();
  return ok({ ambulance: updated[0] });
});
