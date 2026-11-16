import { requireUser } from "@/lib/auth";
import { ok, route } from "@/lib/api";
import { ensureSeeded } from "@/lib/seed";
import { getAdminStats } from "@/lib/dispatch";

export const dynamic = "force-dynamic";

/** Idempotent demo-data bootstrap (also runs automatically on first request). */
export const POST = route(async () => {
  await requireUser(["admin"]);
  await ensureSeeded();
  const stats = await getAdminStats();
  return ok({ ok: true, totals: stats.totals });
});
