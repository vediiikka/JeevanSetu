import { desc, eq } from "@/db";
import { db } from "@/db";
import { roadDisruptions } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import {
  ok,
  optionalString,
  readJson,
  requireEnum,
  requireLat,
  requireLng,
  requireString,
  route,
} from "@/lib/api";
import { DISRUPTION_SEVERITIES, DISRUPTION_TYPES } from "@/lib/domain";
import { findNearestSegment, listActiveDisruptionsWithRoad, notify } from "@/lib/dispatch";
import { listPendingReports } from "@/lib/ingest";
import { monitorActiveRoutes } from "@/lib/reroute";
import { geohash } from "@/lib/geo";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await ensureSeeded();
  const [active, all, pending] = await Promise.all([
    listActiveDisruptionsWithRoad(),
    db.select().from(roadDisruptions).orderBy(desc(roadDisruptions.id)).limit(60),
    listPendingReports(20),
  ]);
  return ok({
    active,
    all,
    pendingReports: pending,
    summary: {
      active: active.length,
      verified: active.filter((item) => item.verification === "verified").length,
      community: active.filter((item) => item.verification === "community").length,
      unverified: active.filter((item) => item.verification === "unverified").length,
      needsReview: active.filter((item) => item.needsReview).length,
      averageConfidence:
        active.length > 0
          ? Number((active.reduce((sum, item) => sum + item.confidence, 0) / active.length).toFixed(2))
          : 0,
    },
  });
});

export const POST = route(async (request: Request) => {
  const user = await requireUser(["admin", "driver"]);
  const body = await readJson(request);
  const lat = requireLat(body.lat, "latitude");
  const lng = requireLng(body.lng, "longitude");
  const type = requireEnum(body.type, DISRUPTION_TYPES.map((d) => d.value), "type");
  const severity = requireEnum(body.severity ?? "moderate", DISRUPTION_SEVERITIES, "severity");
  const title = requireString(body.title, "title", 160);
  const nearest = await findNearestSegment({ lat, lng });

  const isAdmin = user.role === "admin";
  const inserted = await db
    .insert(roadDisruptions)
    .values({
      segmentId: nearest?.segment.id ?? null,
      title,
      type,
      severity,
      status: "active",
      description: optionalString(body.description, 1000),
      lat,
      lng,
      geohash: geohash(lat, lng),
      geometry: nearest?.segment.geometry ?? null,
      reportedBy: optionalString(body.reportedBy, 120) || (isAdmin ? "Admin console" : "Driver report"),
      source: isAdmin ? "admin" : "field",
      // Human-reported events: an operator report is verified, a crew report is community-verified.
      sourceKey: isAdmin ? "admin_console" : "driver_report",
      sourceName: isAdmin ? "Admin control-room report" : "Ambulance crew field report",
      license: "Internal",
      confidence: isAdmin ? 0.95 : 0.8,
      verification: isAdmin ? "verified" : "community",
      direction: optionalString(body.direction, 40) || "both",
      rawText: optionalString(body.description, 1000) || title,
      extractedRoadName: nearest?.segment.roadName ?? null,
      matchedSegmentIds: nearest ? [nearest.segment.id] : [],
      matchMethod: nearest ? "geometry" : "none",
      needsReview: !nearest,
      startsAt: new Date(),
      eventEndsAt: optionalString(body.endsAt, 40) ? new Date(String(body.endsAt)) : null,
      lastFetchedAt: new Date(),
    })
    .returning();

  const monitor = await monitorActiveRoutes();
  await notify({
    role: "admin",
    requestId: null,
    type: "disruption_created",
    title: `New disruption: ${title}`,
    body: `${severity} severity on ${nearest?.segment.roadName ?? "unmapped road"} · ${monitor.decisions.length} reroute decision(s)`,
  });
  await notify({
    role: "driver",
    type: "disruption_created",
    title: `Road disruption: ${title}`,
    body: nearest ? `Affects ${nearest.segment.roadName}` : "Location reported",
  });

  return ok({ disruption: inserted[0], roadName: nearest?.segment.roadName ?? null, monitor }, 201);
});

export const PATCH = route(async (request: Request) => {
  await requireUser(["admin"]);
  const body = await readJson(request);
  const id = Number(body.id);
  if (!Number.isFinite(id)) throw new HttpError(400, "Disruption id is required");
  const status = requireEnum(body.status ?? "resolved", ["active", "resolved"] as const, "status");
  const updated = await db
    .update(roadDisruptions)
    .set({ status, resolvedAt: status === "resolved" ? new Date() : null })
    .where(eq(roadDisruptions.id, id))
    .returning();
  if (!updated[0]) throw new HttpError(404, "Disruption not found");
  const monitor = await monitorActiveRoutes();
  return ok({ disruption: updated[0], monitor });
});
