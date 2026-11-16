import { ok, readJson, route } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { listIngestionRuns, runIngestion } from "@/lib/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Run the modular ingestion pipeline (fetch → NLP → geocode → match → store → reroute). */
export const POST = route(async (request: Request) => {
  await requireUser(["admin"]);
  let sourceKeys: string[] | undefined;
  try {
    const body = (await readJson(request)) as { sourceKeys?: string[] };
    if (Array.isArray(body.sourceKeys)) sourceKeys = body.sourceKeys.filter((key): key is string => typeof key === "string");
  } catch {
    sourceKeys = undefined;
  }
  const summary = await runIngestion({ sourceKeys });
  return ok(summary);
});

export const GET = route(async () => {
  await requireUser(["admin"]);
  const runs = await listIngestionRuns(20);
  return ok({ runs });
});
