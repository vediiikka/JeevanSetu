import { requireUser } from "@/lib/auth";
import { ok, route } from "@/lib/api";
import { getLiveSnapshot } from "@/lib/dispatch";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";

/** Operational snapshot — restricted to the admin control room. */
export const GET = route(async () => {
  await requireUser(["admin"]);
  await ensureSeeded();
  const snapshot = await getLiveSnapshot();
  return ok(snapshot);
});
