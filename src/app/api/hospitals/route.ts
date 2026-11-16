import { asc, eq } from "@/db";
import { db } from "@/db";
import { hospitals } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import {
  fail,
  ok,
  optionalString,
  readJson,
  requireEnum,
  requireLat,
  requireLng,
  requireString,
  route,
} from "@/lib/api";
import { geohash } from "@/lib/geo";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await ensureSeeded();
  const rows = await db.select().from(hospitals).orderBy(asc(hospitals.name));
  return ok({ hospitals: rows });
});

export const POST = route(async (request: Request) => {
  await requireUser(["admin"]);
  const body = await readJson(request);
  const name = requireString(body.name, "name", 160);
  const lat = requireLat(body.lat);
  const lng = requireLng(body.lng);
  const facilities = Array.isArray(body.facilities) ? body.facilities.filter((f): f is string => typeof f === "string") : [];
  const capabilities = Array.isArray(body.capabilities)
    ? body.capabilities.filter((f): f is string => typeof f === "string")
    : [];
  const code = optionalString(body.code, 40) || `HSP-${name.slice(0, 3).toUpperCase()}-${Date.now().toString().slice(-4)}`;

  const existing = await db.select({ id: hospitals.id }).from(hospitals).where(eq(hospitals.code, code)).limit(1);
  if (existing.length > 0) throw new HttpError(409, "A hospital with this code already exists");

  const inserted = await db
    .insert(hospitals)
    .values({
      code,
      name,
      address: requireString(body.address, "address", 300),
      city: requireString(body.city, "city", 80),
      district: optionalString(body.district, 80),
      lat,
      lng,
      geohash: geohash(lat, lng),
      phone: optionalString(body.phone, 40),
      emergencyLevel: requireEnum(body.emergencyLevel ?? "Level II", ["Level I", "Level II", "Level III"], "emergencyLevel"),
      traumaLevel: optionalString(body.traumaLevel, 80),
      facilities,
      capabilities,
      verified: Boolean(body.verified),
      status: "active",
    })
    .returning();
  return ok({ hospital: inserted[0] }, 201);
});

export const PATCH = route(async (request: Request) => {
  await requireUser(["admin"]);
  const body = await readJson(request);
  const id = Number(body.id);
  if (!Number.isFinite(id)) return fail("Hospital id is required", 400);
  const patch: Record<string, unknown> = {};
  if (typeof body.status === "string") patch.status = body.status;
  if (typeof body.verified === "boolean") patch.verified = body.verified;
  if (typeof body.phone === "string") patch.phone = body.phone;
  if (typeof body.emergencyLevel === "string") patch.emergencyLevel = body.emergencyLevel;
  if (typeof body.traumaLevel === "string") patch.traumaLevel = body.traumaLevel;
  if (Array.isArray(body.facilities)) patch.facilities = body.facilities;
  if (Array.isArray(body.capabilities)) patch.capabilities = body.capabilities;
  if (Object.keys(patch).length === 0) return fail("Nothing to update", 400);
  const updated = await db.update(hospitals).set(patch).where(eq(hospitals.id, id)).returning();
  if (!updated[0]) throw new HttpError(404, "Hospital not found");
  return ok({ hospital: updated[0] });
});
