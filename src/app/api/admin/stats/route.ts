import { requireUser } from "@/lib/auth";
import { ok, route } from "@/lib/api";
import { getAdminStats } from "@/lib/dispatch";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireUser(["admin"]);
  await ensureSeeded();
  const stats = await getAdminStats();
  return ok(stats);
});
