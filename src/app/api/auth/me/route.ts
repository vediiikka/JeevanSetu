import { eq } from "@/db";
import { db } from "@/db";
import { drivers } from "@/db/schema";
import { getSessionUser } from "@/lib/auth";
import { ok, route } from "@/lib/api";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await getSessionUser();
  if (!user) return ok({ user: null, driver: null });
  const driverRows = await db.select().from(drivers).where(eq(drivers.userId, user.id)).limit(1);
  return ok({ user, driver: driverRows[0] ?? null });
});
