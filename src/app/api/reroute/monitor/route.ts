import { ok, route } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { listRerouteEvents, monitorActiveRoutes } from "@/lib/reroute";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Run the automatic rerouting monitor across all active trips. */
export const POST = route(async () => {
  await requireUser(["admin", "driver"]);
  const result = await monitorActiveRoutes();
  return ok(result);
});

export const GET = route(async () => {
  await requireUser(["admin"]);
  const events = await listRerouteEvents(25);
  return ok({ events });
});
