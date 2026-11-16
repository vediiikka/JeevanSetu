import { asc, eq } from "@/db";
import { db } from "@/db";
import { ambulances, drivers, hospitals, users } from "@/db/schema";
import { hashPassword, HttpError, requireUser } from "@/lib/auth";
import { ok, optionalString, readJson, requireEnum, requireString, route } from "@/lib/api";
import { ensureSeeded } from "@/lib/seed";
import { isHindiName } from "@/lib/hindiNames";
import { slugName } from "@/lib/loginName";
import { geohash } from "@/lib/geo";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await ensureSeeded();
  const rows = await db.select().from(drivers).orderBy(asc(drivers.name));
  return ok({ drivers: rows });
});

export const POST = route(async (request: Request) => {
  await requireUser(["admin"]);
  const body = await readJson(request);
  const name = requireString(body.name, "name", 120).replace(/\s+/g, " ");
  if (!isHindiName(name)) {
    throw new HttpError(
      400,
      "Driver names must be Hindu names: an approved first name and surname (use “Suggest name” for a valid one).",
    );
  }
  const phone = optionalString(body.phone, 40);
  const password = optionalString(body.password, 100) || "driver123";
  if (password.length < 6) throw new HttpError(400, "Password must be at least 6 characters");

  // The login is derived from the name (rakesh.patel), unless an address is given explicitly.
  const explicitEmail = optionalString(body.email, 160).toLowerCase();
  const existingUsers = await db.select({ email: users.email }).from(users);
  const taken = new Set(existingUsers.map((u) => u.email));
  let email = explicitEmail;
  if (email) {
    if (taken.has(email)) throw new HttpError(409, "A user with this email already exists");
  } else {
    const base = slugName(name);
    email = `${base}@jeevansetu.in`;
    for (let suffix = 2; taken.has(email); suffix += 1) email = `${base}${suffix}@jeevansetu.in`;
  }

  // Either attach a free ambulance, or create a new one at a base hospital (never both).
  const ambulanceId = body.ambulanceId ? Number(body.ambulanceId) : null;
  const newVehicle = body.newAmbulance && typeof body.newAmbulance === "object" ? (body.newAmbulance as Record<string, unknown>) : null;
  if (ambulanceId !== null && newVehicle) throw new HttpError(400, "Choose an existing ambulance or a new one, not both");
  if (ambulanceId !== null) {
    const vehicle = (await db.select().from(ambulances).where(eq(ambulances.id, ambulanceId)).limit(1))[0];
    if (!vehicle) throw new HttpError(404, "Ambulance not found");
    if (vehicle.driverId) throw new HttpError(409, `${vehicle.code} already has a driver`);
  }
  let baseHospital: { id: number; lat: number; lng: number; name: string } | null = null;
  let vehicleType = "BLS";
  if (newVehicle) {
    vehicleType = requireEnum(newVehicle.type ?? "BLS", ["BLS", "ALS", "ICU", "Neonatal"] as const, "ambulance type");
    const hospitalId = Number(newVehicle.hospitalId);
    const hospitalRow = Number.isFinite(hospitalId)
      ? (await db.select().from(hospitals).where(eq(hospitals.id, hospitalId)).limit(1))[0]
      : undefined;
    if (!hospitalRow) throw new HttpError(400, "Choose the base hospital for the new ambulance");
    baseHospital = { id: hospitalRow.id, lat: hospitalRow.lat, lng: hospitalRow.lng, name: hospitalRow.name };
  }

  const insertedUser = await db
    .insert(users)
    .values({ name, email, phone, role: "driver", passwordHash: await hashPassword(password) })
    .returning();
  const insertedDriver = await db
    .insert(drivers)
    .values({
      userId: insertedUser[0].id,
      name,
      phone,
      licenseNo: optionalString(body.licenseNo, 60) || `GJ-DL-${new Date().getFullYear()}-${Date.now().toString().slice(-5)}`,
      status: requireEnum(body.status ?? "offline", ["online", "offline", "on_trip"], "status"),
      ambulanceId,
    })
    .returning();
  const driver = insertedDriver[0];
  let vehicleCode: string | null = null;
  if (ambulanceId !== null) {
    await db.update(ambulances).set({ driverId: driver.id }).where(eq(ambulances.id, ambulanceId));
    vehicleCode = (await db.select().from(ambulances).where(eq(ambulances.id, ambulanceId)).limit(1))[0]?.code ?? null;
  } else if (baseHospital) {
    const existingCodes = (await db.select({ code: ambulances.code }).from(ambulances)).map((a) => a.code);
    const numbers = existingCodes.map((code) => Number(code.match(/(\d+)$/)?.[1] ?? 0));
    const next = Math.max(0, ...numbers) + 1;
    const code = `GJ-AMB-${String(next).padStart(2, "0")}`;
    const facilities = vehicleType === "ICU" ? ["ventilator", "monitor", "infusion"] : vehicleType === "Neonatal" ? ["incubator", "ventilator", "monitor"] : vehicleType === "ALS" ? ["oxygen", "defibrillator", "ventilator"] : ["oxygen", "first_aid"];
    const createdVehicle = await db
      .insert(ambulances)
      .values({
        code,
        type: vehicleType,
        status: "available",
        lat: baseHospital.lat,
        lng: baseHospital.lng,
        geohash: geohash(baseHospital.lat, baseHospital.lng),
        driverId: driver.id,
        hospitalId: baseHospital.id,
        facilities,
        lastSeenAt: new Date(),
      })
      .returning();
    await db.update(drivers).set({ ambulanceId: createdVehicle[0].id }).where(eq(drivers.id, driver.id));
    vehicleCode = code;
  }
  return ok({ driver, vehicle: vehicleCode, login: { username: email.split("@")[0], email, password } }, 201);
});

export const PATCH = route(async (request: Request) => {
  const user = await requireUser(["admin", "driver"]);
  const body = await readJson(request);
  const id = Number(body.id);
  if (!Number.isFinite(id)) throw new HttpError(400, "Driver id is required");

  if (user.role === "driver") {
    const rows = await db.select().from(drivers).where(eq(drivers.userId, user.id)).limit(1);
    if (!rows[0] || rows[0].id !== id) throw new HttpError(403, "You can only update your own driver profile");
  }

  const patch: Record<string, unknown> = { lastSeenAt: new Date() };
  if (typeof body.status === "string") patch.status = requireEnum(body.status, ["online", "offline", "on_trip"], "status");
  if (body.ambulanceId !== undefined) patch.ambulanceId = body.ambulanceId ? Number(body.ambulanceId) : null;
  if (typeof body.phone === "string") patch.phone = optionalString(body.phone, 40);
  if (typeof body.licenseNo === "string") patch.licenseNo = optionalString(body.licenseNo, 60);

  const updated = await db.update(drivers).set(patch).where(eq(drivers.id, id)).returning();
  if (!updated[0]) throw new HttpError(404, "Driver not found");
  return ok({ driver: updated[0] });
});
