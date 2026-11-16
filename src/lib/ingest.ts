import { and, asc, desc, eq, inArray, lt } from "@/db";
import { db } from "@/db";
import {
  dataSources,
  disruptionReports,
  ingestionRuns,
  notifications,
  roadDisruptions,
  roadSegments,
} from "@/db/schema";
import { geohash } from "@/lib/geo";
import { extractDisruption } from "@/lib/nlp";
import { geocodeText, matchDisruptionToSegments } from "@/lib/matching";
import { ADAPTERS, ENABLED_ADAPTERS, SOURCE_BY_KEY, SOURCE_CATALOG, type RawObservation } from "@/lib/sources";
import { monitorActiveRoutes } from "@/lib/reroute";

export type SourceRunResult = {
  key: string;
  name: string;
  status: "success" | "partial" | "failed" | "skipped";
  fetched: number;
  created: number;
  updated: number;
  flagged: number;
  error?: string;
  message: string;
};

export type IngestionSummary = {
  startedAt: string;
  finishedAt: string;
  sources: SourceRunResult[];
  totals: { fetched: number; created: number; updated: number; flagged: number; expired: number };
  reroutes: number;
};

/** Upsert the evaluated source catalogue so operators always see the latest status. */
export async function ensureSourceRegistry(): Promise<void> {
  for (const source of SOURCE_CATALOG) {
    await db
      .insert(dataSources)
      .values({
        key: source.key,
        name: source.name,
        category: source.category,
        url: source.url,
        license: source.license,
        coverage: source.coverage,
        updateFrequency: source.updateFrequency,
        authentication: source.authentication,
        reliability: source.reliability,
        adapter: source.adapter,
        notes: source.notes,
        status: source.enabled ? (source.adapter === "none" ? "active" : "planned") : "unavailable",
      })
      .onConflictDoUpdate({
        target: dataSources.key,
        set: {
          name: source.name,
          category: source.category,
          url: source.url,
          license: source.license,
          coverage: source.coverage,
          updateFrequency: source.updateFrequency,
          authentication: source.authentication,
          reliability: source.reliability,
          adapter: source.adapter,
          notes: source.notes,
          // Sources without a fetch adapter (manual entry / geocoding helpers) are
          // always "active"; adapter-backed sources stay "planned" until they run.
          ...(ADAPTERS[source.adapter] ? {} : { status: source.enabled ? "active" : "unavailable" }),
        },
      });
  }
}

/** Expire events whose expected end time has passed — they must stop affecting routing. */
export async function expireStaleDisruptions(): Promise<number> {
  const now = new Date();
  const expired = await db
    .update(roadDisruptions)
    .set({ status: "expired", resolvedAt: now, updatedAt: now })
    .where(and(eq(roadDisruptions.status, "active"), lt(roadDisruptions.eventEndsAt, now)))
    .returning();
  return expired.length;
}

function finalSeverity(severity: string): string {
  if (severity === "critical") return "critical";
  return severity;
}

async function storeObservation(params: {
  observation: RawObservation;
  sourceKey: string;
  sourceName: string;
  license: string;
  reliability: "high" | "medium" | "low";
  verification: "verified" | "community" | "unverified";
}): Promise<{ created: boolean; flagged: boolean; disruptionId: number | null }> {
  const { observation, sourceKey, sourceName, license, reliability, verification } = params;
  const text = `${observation.title}. ${observation.description} ${observation.rawText}`.trim();
  const nlp = extractDisruption(text, {
    sourceReliability: reliability,
    hintCategory: observation.category,
    hintSeverity: observation.severity,
  });

  let lat = observation.lat ?? null;
  let lng = observation.lng ?? null;
  let geocodeSource = lat !== null && lng !== null ? "adapter" : "none";
  let roadName = observation.roadName ?? nlp.roadName;

  if ((lat === null || lng === null) && roadName) {
    const geocoded = await geocodeText(roadName);
    if (geocoded) {
      lat = geocoded.lat;
      lng = geocoded.lng;
      geocodeSource = geocoded.source;
    }
  }

  const match = await matchDisruptionToSegments({
    lat,
    lng,
    roadName,
    description: text,
    direction: observation.direction ?? nlp.direction,
  });

  const confidence = Number(Math.min(0.98, nlp.confidence * 0.6 + match.confidence * 0.4).toFixed(2));
  const needsReview = match.needsReview || nlp.needsReview || confidence < 0.65;
  const resolvedRoad = match.candidates[0]?.roadName ?? roadName ?? null;
  const resolvedLat = lat ?? match.resolvedLat ?? 23.0225;
  const resolvedLng = lng ?? match.resolvedLng ?? 72.5714;

  let matchedGeometry: [number, number][] | null = null;
  if (match.segmentIds.length > 0) {
    const geometryRows = await db
      .select({ geometry: roadSegments.geometry })
      .from(roadSegments)
      .where(eq(roadSegments.id, match.segmentIds[0]))
      .limit(1);
    matchedGeometry = geometryRows[0]?.geometry ?? null;
  }

  const values = {
    segmentId: match.segmentIds[0] ?? null,
    title: observation.title,
    type: nlp.category,
    severity: finalSeverity(nlp.severity),
    status: "active" as const,
    description: observation.description,
    lat: resolvedLat,
    lng: resolvedLng,
    geohash: geohash(resolvedLat, resolvedLng),
    geometry: matchedGeometry,
    reportedBy: sourceName,
    source: sourceKey === "open_meteo" ? "weather" : sourceKey === "osm_overpass" ? "osm" : "nlp",
    sourceKey,
    sourceName,
    sourceUrl: observation.url ?? SOURCE_BY_KEY.get(sourceKey)?.url ?? null,
    license,
    externalId: observation.externalId,
    confidence,
    verification,
    direction: observation.direction ?? nlp.direction,
    rawText: text.slice(0, 4000),
    extractedRoadName: resolvedRoad,
    matchedSegmentIds: match.segmentIds,
    matchMethod: match.method,
    needsReview,
    eventStartsAt: observation.startsAt ?? nlp.startsAt ?? new Date(),
    eventEndsAt: observation.endsAt ?? nlp.endsAt ?? null,
    lastFetchedAt: new Date(),
    startsAt: observation.startsAt ?? nlp.startsAt ?? new Date(),
    endsAt: observation.endsAt ?? nlp.endsAt ?? null,
    updatedAt: new Date(),
  };

  const existing = observation.externalId
    ? await db
        .select({ id: roadDisruptions.id })
        .from(roadDisruptions)
        .where(and(eq(roadDisruptions.sourceKey, sourceKey), eq(roadDisruptions.externalId, observation.externalId)))
        .limit(1)
    : [];

  let disruptionId: number | null = existing[0]?.id ?? null;
  let created = false;

  if (existing[0]) {
    await db
      .update(roadDisruptions)
      .set({ ...values, status: "active", resolvedAt: null })
      .where(eq(roadDisruptions.id, existing[0].id));
  } else {
    const inserted = await db
      .insert(roadDisruptions)
      .values(values)
      .onConflictDoNothing()
      .returning();
    disruptionId = inserted[0]?.id ?? null;
    created = Boolean(inserted[0]);
  }

  let flagged = false;
  if (needsReview || match.segmentIds.length === 0) {
    const pending = await db
      .select({ id: disruptionReports.id })
      .from(disruptionReports)
      .where(
        and(
          eq(disruptionReports.sourceKey, sourceKey),
          eq(disruptionReports.externalId, observation.externalId ?? ""),
          eq(disruptionReports.status, "pending"),
        ),
      )
      .limit(1);
    if (pending.length === 0) {
      await db.insert(disruptionReports).values({
        sourceKey,
        sourceName,
        externalId: observation.externalId ?? null,
        rawText: text.slice(0, 4000),
        title: observation.title,
        category: nlp.category,
        severity: nlp.severity,
        confidence,
        roadName: resolvedRoad,
        lat: resolvedLat,
        lng: resolvedLng,
        matchedSegmentIds: match.segmentIds,
        status: "pending",
        disruptionId,
      });
      flagged = true;
    }
  }

  void geocodeSource;
  return { created, flagged, disruptionId };
}

/**
 * Full ingestion pass: fetch → parse → extract → geocode → match → score →
 * upsert → expire → reroute. Each source is isolated so one failure cannot
 * break the others.
 */
export async function runIngestion(options: { sourceKeys?: string[] } = {}): Promise<IngestionSummary> {
  await ensureSourceRegistry();
  const startedAt = new Date();
  const expired = await expireStaleDisruptions();
  const results: SourceRunResult[] = [];

  const targets = ENABLED_ADAPTERS.filter((source) => !options.sourceKeys || options.sourceKeys.includes(source.key));

  await Promise.all(
    targets.map(async (source) => {
      const adapter = ADAPTERS[source.adapter];
      const runStart = new Date();
      let fetched = 0;
      let created = 0;
      let updated = 0;
      let flagged = 0;
      let errorMessage: string | undefined;

      if (!adapter) {
        results.push({
          key: source.key,
          name: source.name,
          status: "skipped",
          fetched: 0,
          created: 0,
          updated: 0,
          flagged: 0,
          message: "No adapter registered",
        });
        return;
      }

      try {
        const result = await adapter.fetch(AbortSignal.timeout(15000));
        fetched = result.observations.length;
        errorMessage = result.error;

        for (const observation of result.observations) {
          const stored = await storeObservation({
            observation,
            sourceKey: source.key,
            sourceName: source.name,
            license: source.license,
            reliability: source.reliability,
            verification: source.key === "open_meteo" ? "unverified" : "community",
          });
          if (stored.created) created += 1;
          else updated += 1;
          if (stored.flagged) flagged += 1;
        }
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : "adapter failed";
      }

      const status: SourceRunResult["status"] =
        errorMessage && fetched === 0 ? "failed" : errorMessage ? "partial" : "success";

      const message =
        status === "failed"
          ? `Source unreachable: ${errorMessage}`
          : status === "partial"
            ? `Partially succeeded (${fetched} items) — ${errorMessage}`
            : `${fetched} item(s) processed`;

      results.push({
        key: source.key,
        name: source.name,
        status,
        fetched,
        created,
        updated,
        flagged,
        error: errorMessage,
        message,
      });

      await db
        .update(dataSources)
        .set({
          status: status === "failed" ? "unavailable" : status === "partial" ? "degraded" : "active",
          lastRunAt: new Date(),
          lastStatus: status,
          lastError: errorMessage ?? null,
          lastItemCount: fetched,
        })
        .where(eq(dataSources.key, source.key));

      await db.insert(ingestionRuns).values({
        sourceKey: source.key,
        sourceName: source.name,
        status,
        itemsFetched: fetched,
        itemsCreated: created,
        itemsUpdated: updated,
        itemsExpired: 0,
        itemsFlagged: flagged,
        message,
        error: errorMessage ?? null,
        startedAt: runStart,
        finishedAt: new Date(),
      });
    }),
  );

  const monitor = await monitorActiveRoutes();

  const summary: IngestionSummary = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    sources: results.sort((a, b) => a.key.localeCompare(b.key)),
    totals: {
      fetched: results.reduce((sum, item) => sum + item.fetched, 0),
      created: results.reduce((sum, item) => sum + item.created, 0),
      updated: results.reduce((sum, item) => sum + item.updated, 0),
      flagged: results.reduce((sum, item) => sum + item.flagged, 0),
      expired,
    },
    reroutes: monitor.decisions.length,
  };

  await db.insert(notifications).values({
    role: "admin",
    type: "ingestion",
    title: `Disruption ingestion completed`,
    body: `${summary.totals.fetched} fetched · ${summary.totals.created} new · ${summary.totals.updated} updated · ${summary.totals.expired} expired · ${summary.totals.flagged} flagged for review · ${summary.reroutes} reroute decision(s)`,
  });

  return summary;
}

/** Confirm or reject a queued report; both actions re-run the routing monitor. */
export async function verifyDisruption(params: {
  id: number;
  action: "verify" | "reject";
  note?: string;
}): Promise<{ ok: boolean; monitor: Awaited<ReturnType<typeof monitorActiveRoutes>> }> {
  const rows = await db.select().from(roadDisruptions).where(eq(roadDisruptions.id, params.id)).limit(1);
  const disruption = rows[0];
  if (!disruption) throw new Error("Disruption not found");

  if (params.action === "verify") {
    await db
      .update(roadDisruptions)
      .set({
        verification: "verified",
        needsReview: false,
        confidence: Math.max(disruption.confidence, 0.85),
        status: "active",
        resolvedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(roadDisruptions.id, params.id));
  } else {
    await db
      .update(roadDisruptions)
      .set({ verification: "rejected", status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(roadDisruptions.id, params.id));
  }

  await db
    .update(disruptionReports)
    .set({
      status: params.action === "verify" ? "accepted" : "rejected",
      reviewNote: params.note ?? "",
      reviewedAt: new Date(),
      disruptionId: params.id,
    })
    .where(eq(disruptionReports.disruptionId, params.id));

  const monitor = await monitorActiveRoutes();
  return { ok: true, monitor };
}

export async function listPendingReports(limit = 25) {
  return db
    .select()
    .from(disruptionReports)
    .where(eq(disruptionReports.status, "pending"))
    .orderBy(desc(disruptionReports.confidence))
    .limit(limit);
}

export async function listIngestionRuns(limit = 15) {
  return db.select().from(ingestionRuns).orderBy(desc(ingestionRuns.id)).limit(limit);
}

export async function listSourceStatus() {
  await ensureSourceRegistry();
  return db.select().from(dataSources).orderBy(asc(dataSources.category), asc(dataSources.name));
}

export async function countActiveDisruptions(): Promise<number> {
  const rows = await db.select().from(roadDisruptions).where(inArray(roadDisruptions.status, ["active"]));
  return rows.length;
}
