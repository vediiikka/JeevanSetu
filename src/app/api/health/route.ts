import { mongoHealth } from "@/db";
import { ok, route } from "@/lib/api";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const health = await mongoHealth();
  const payload = { ...health, database: "mongodb", databaseName: health.database };
  if (!health.ok) {
    return Response.json({ ...payload, ok: false }, { status: 500 });
  }
  return ok({ ...payload, ok: true });
});
