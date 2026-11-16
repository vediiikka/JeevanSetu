import { ok, route } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { listSourceStatus } from "@/lib/ingest";
import { SOURCE_CATALOG } from "@/lib/sources";

export const dynamic = "force-dynamic";

/** Source catalogue + live adapter status (transparency for every data source). */
export const GET = route(async () => {
  await requireUser(["admin", "driver"]);
  const status = await listSourceStatus();
  const byKey = new Map(status.map((row) => [row.key, row]));
  return ok({
    sources: SOURCE_CATALOG.map((source) => {
      const runtime = byKey.get(source.key);
      return {
        ...source,
        runtimeStatus: runtime?.status ?? (source.enabled ? "planned" : "unavailable"),
        lastRunAt: runtime?.lastRunAt ?? null,
        lastStatus: runtime?.lastStatus ?? null,
        lastError: runtime?.lastError ?? null,
        lastItemCount: runtime?.lastItemCount ?? 0,
      };
    }),
  });
});
