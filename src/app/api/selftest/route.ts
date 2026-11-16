import { ok, route } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { runSelfTest } from "@/lib/selftest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Deterministic scenario suite for the disruption-intelligence + routing pipeline. */
export const GET = route(async () => {
  await requireUser(["admin", "driver"]);
  const report = await runSelfTest();
  return ok(report);
});

export const POST = route(async () => {
  await requireUser(["admin"]);
  const report = await runSelfTest();
  return ok(report);
});
