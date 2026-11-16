import { requireUser } from "@/lib/auth";
import { ok, route } from "@/lib/api";
import { getAdminLiveSnapshot } from "@/lib/dispatch";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";

/** Live tracking of every ambulance, its driver, mission and road route (admin only). */
export const GET = route(async () => {
  await requireUser(["admin"]);
  await ensureSeeded();
  const snapshot = await getAdminLiveSnapshot();
  return ok(snapshot);
});
