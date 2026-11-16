import { HttpError, requireUser } from "@/lib/auth";
import { ok, route } from "@/lib/api";
import { getDriverProfile } from "@/lib/driverProfile";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";

/** Full driver profile for the admin control room (admin only). */
export const GET = route(async (_request: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireUser(["admin"]);
  await ensureSeeded();
  const { id } = await ctx.params;
  const driverId = Number(id);
  if (!Number.isInteger(driverId) || driverId <= 0) throw new HttpError(400, "Driver id must be a positive number");
  const profile = await getDriverProfile(driverId);
  if (!profile) throw new HttpError(404, "Driver not found");
  return ok(profile);
});
