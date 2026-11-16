import { eq } from "@/db";
import { db } from "@/db";
import { drivers } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { ok, optionalString, readJson, requireEnum, route } from "@/lib/api";
import { respondToAssignment } from "@/lib/dispatch";

export const dynamic = "force-dynamic";

export const POST = route(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(["driver"]);
  const { id } = await ctx.params;
  const body = await readJson(request);
  const rows = await db.select().from(drivers).where(eq(drivers.userId, user.id)).limit(1);
  const driver = rows[0];
  if (!driver) throw new HttpError(403, "No driver profile linked to this account");

  const result = await respondToAssignment({
    requestId: Number(id),
    driverId: driver.id,
    action: requireEnum(body.action, ["accept", "reject"] as const, "action"),
    reason: optionalString(body.reason, 300),
  });
  return ok(result);
});
