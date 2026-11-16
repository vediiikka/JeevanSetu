import { ok, route } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { getRequestDetail } from "@/lib/dispatch";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const detail = await getRequestDetail(id);
  if (!detail) throw new HttpError(404, "Emergency request not found");
  return ok({ detail });
});
