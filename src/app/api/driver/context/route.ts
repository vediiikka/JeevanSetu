import { eq } from "@/db";
import { db } from "@/db";
import { drivers } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { ok, route } from "@/lib/api";
import { getDriverContext } from "@/lib/dispatch";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser(["driver", "admin"]);
  const rows = await db.select().from(drivers).where(eq(drivers.userId, user.id)).limit(1);
  const driver = rows[0];
  if (!driver) throw new HttpError(403, "No driver profile linked to this account");
  const context = await getDriverContext(driver.id);
  return ok({ context });
});
