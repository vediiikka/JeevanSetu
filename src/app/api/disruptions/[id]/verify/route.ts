import { ok, optionalString, readJson, route } from "@/lib/api";
import { HttpError, requireUser } from "@/lib/auth";
import { verifyDisruption } from "@/lib/ingest";

export const dynamic = "force-dynamic";

/** Confirm or reject a queued disruption report; both actions re-run the reroute monitor. */
export const POST = route(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireUser(["admin"]);
  const { id } = await ctx.params;
  const body = await readJson(request);
  const action = body.action === "reject" ? "reject" : "verify";
  const result = await verifyDisruption({
    id: Number(id),
    action,
    note: optionalString(body.note, 500),
  });
  if (!result.ok) throw new HttpError(400, "Disruption could not be updated");
  return ok(result);
});
