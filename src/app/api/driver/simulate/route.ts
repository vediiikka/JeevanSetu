import { eq } from "@/db";
import { db } from "@/db";
import { drivers } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/api";
import { advanceAmbulanceAlongRoute } from "@/lib/dispatch";

export const dynamic = "force-dynamic";

export const POST = route(async (request: Request) => {
  const user = await requireUser(["driver", "admin"]);
  const body = await readJson(request);
  const meters = Number(body.meters ?? 700);

  let ambulanceId = body.ambulanceId ? Number(body.ambulanceId) : null;
  if (!ambulanceId && user.role === "driver") {
    const rows = await db.select().from(drivers).where(eq(drivers.userId, user.id)).limit(1);
    if (!rows[0]?.ambulanceId) throw new HttpError(409, "No ambulance linked to this driver");
    ambulanceId = rows[0].ambulanceId;
  }
  if (!ambulanceId) throw new HttpError(400, "ambulanceId is required");

  const result = await advanceAmbulanceAlongRoute({ ambulanceId, meters });
  return ok(result);
});
