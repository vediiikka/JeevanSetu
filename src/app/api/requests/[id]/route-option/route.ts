import { eq } from "@/db";
import { db } from "@/db";
import { drivers } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { ok, readJson, route } from "@/lib/api";
import { selectRouteOption } from "@/lib/dispatch";

export const dynamic = "force-dynamic";

/** The driver picks the fastest, little-fast or slow route for the current leg. */
export const POST = route(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(["driver"]);
  const { id } = await ctx.params;
  const body = await readJson(request);
  const rows = await db.select().from(drivers).where(eq(drivers.userId, user.id)).limit(1);
  const driver = rows[0];
  if (!driver) throw new HttpError(403, "No driver profile linked to this account");
  const result = await selectRouteOption({
    requestId: Number(id),
    driverId: driver.id,
    option: typeof body.option === "string" ? body.option : "",
  });
  return ok(result);
});
