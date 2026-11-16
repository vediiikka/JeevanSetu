import { eq } from "@/db";
import { db } from "@/db";
import { drivers } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { ok, readJson, requireLat, requireLng, route } from "@/lib/api";
import { ingestDriverGps, setDriverStatus } from "@/lib/dispatch";

export const dynamic = "force-dynamic";

/**
 * Device GPS from the crew's phone. During an active trip the fix only moves the
 * ambulance when it lies on the assigned road route; otherwise the response says
 * so and the ambulance keeps following the route.
 */
export const POST = route(async (request: Request) => {
  const user = await requireUser(["driver"]);
  const body = await readJson(request);
  const lat = requireLat(body.lat, "latitude");
  const lng = requireLng(body.lng, "longitude");
  const rows = await db.select().from(drivers).where(eq(drivers.userId, user.id)).limit(1);
  const driver = rows[0];
  if (!driver) throw new HttpError(403, "No driver profile linked to this account");
  if (!driver.ambulanceId) throw new HttpError(409, "No ambulance linked to this driver");

  const result = await ingestDriverGps({ driverId: driver.id, ambulanceId: driver.ambulanceId, lat, lng });
  await setDriverStatus(driver.id, driver.status === "offline" ? "offline" : "online");
  return ok({ ok: true, ambulanceId: driver.ambulanceId, lat, lng, ...result });
});
