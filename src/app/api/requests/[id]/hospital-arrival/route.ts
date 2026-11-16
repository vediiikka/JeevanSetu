import { eq } from "@/db";
import { db } from "@/db";
import { drivers } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { ok, route } from "@/lib/api";
import { markArrivedAtHospital } from "@/lib/dispatch";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(["driver"]);
  const { id } = await ctx.params;
  const rows = await db.select().from(drivers).where(eq(drivers.userId, user.id)).limit(1);
  const driver = rows[0];
  if (!driver) throw new HttpError(403, "No driver profile linked to this account");
  await markArrivedAtHospital({ requestId: Number(id), driverId: driver.id });
  return ok({ ok: true });
});
