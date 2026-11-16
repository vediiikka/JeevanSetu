import { eq } from "@/db";
import { db } from "@/db";
import { roadSegments } from "@/db/schema";
import type { RoadSegment } from "@/db/schema";
import { haversine, projectOnPolyline, type LatLng } from "@/lib/geo";

export type SegmentCandidate = {
  id: number;
  roadName: string;
  city: string;
  distanceMeters: number;
  nameScore: number;
  score: number;
};

export type SegmentMatch = {
  segmentIds: number[];
  method: "geometry+name" | "geometry" | "name" | "manual" | "none";
  confidence: number;
  needsReview: boolean;
  candidates: SegmentCandidate[];
  resolvedLat: number | null;
  resolvedLng: number | null;
  notes: string;
};

type SegmentRow = RoadSegment;

const AREA_GAZETTEER: { name: string; lat: number; lng: number }[] = [
  { name: "Ahmedabad", lat: 23.0225, lng: 72.5714 },
  { name: "Gandhinagar", lat: 23.2156, lng: 72.6369 },
  { name: "Vadodara", lat: 22.3072, lng: 73.1812 },
  { name: "Surat", lat: 21.1702, lng: 72.8311 },
  { name: "Rajkot", lat: 22.3039, lng: 70.8022 },
  { name: "Paldi", lat: 23.0106, lng: 72.5651 },
  { name: "Navrangpura", lat: 23.03, lng: 72.55 },
  { name: "Maninagar", lat: 22.99, lng: 72.6 },
  { name: "Naroda", lat: 23.07, lng: 72.65 },
  { name: "Vastral", lat: 23.0, lng: 72.65 },
  { name: "Nikol", lat: 23.03, lng: 72.68 },
  { name: "Odhav", lat: 23.05, lng: 72.7 },
  { name: "Kathwada", lat: 23.1, lng: 72.75 },
  { name: "Prahladnagar", lat: 23.01, lng: 72.51 },
  { name: "Kankaria", lat: 23.0203, lng: 72.5451 },
  { name: "Shahibaug", lat: 23.0333, lng: 72.5833 },
  { name: "Adajan", lat: 21.17, lng: 72.78 },
  { name: "Vesu", lat: 21.15, lng: 72.8 },
  { name: "Udhna", lat: 21.16, lng: 72.86 },
  { name: "Gotri", lat: 22.33, lng: 73.15 },
  { name: "Alkapuri", lat: 22.32, lng: 73.18 },
  { name: "Sector 21", lat: 23.22, lng: 72.65 },
  { name: "GIFT City", lat: 23.16, lng: 72.68 },
  { name: "Kudasan", lat: 23.17, lng: 72.64 },
  { name: "University Road", lat: 22.31, lng: 70.81 },
  { name: "Halol", lat: 22.15, lng: 73.24 },
  { name: "Anand", lat: 22.45, lng: 73.12 },
  { name: "Navsari", lat: 21.02, lng: 72.8 },
  { name: "Bardoli", lat: 21.11, lng: 72.96 },
];

const geocodeCache = new Map<string, { lat: number; lng: number; label: string; source: string }>();

/** Resolve free-text location mentions to coordinates (gazetteer first, then Nominatim). */
export async function geocodeText(text: string): Promise<{ lat: number; lng: number; label: string; source: string } | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const cacheKey = trimmed.toLowerCase();
  const cached = geocodeCache.get(cacheKey);
  if (cached) return cached;

  const lower = trimmed.toLowerCase();
  const area = AREA_GAZETTEER.find((entry) => lower.includes(entry.name.toLowerCase()));
  if (area) {
    const result = { lat: area.lat, lng: area.lng, label: area.name, source: "gazetteer" };
    geocodeCache.set(cacheKey, result);
    return result;
  }

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(`${trimmed}, Gujarat, India`)}`,
      {
        headers: {
          "User-Agent": "JeevanSetu/1.0 (emergency routing demo; contact admin@jeevansetu.in)",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(6000),
        cache: "no-store",
      },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as { lat: string; lon: string; display_name: string }[];
    const first = payload[0];
    if (!first) return null;
    const result = {
      lat: Number(first.lat),
      lng: Number(first.lon),
      label: first.display_name,
      source: "nominatim",
    };
    geocodeCache.set(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

function nameSimilarity(a: string, b: string): number {
  const left = a.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const right = b.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  if (left.length === 0 || right.length === 0) return 0;
  const setB = new Set(right);
  const overlap = left.filter((token) => setB.has(token)).length;
  return overlap / Math.max(left.length, right.length);
}

/**
 * Map a disruption onto road segments using spatial proximity, road-name
 * similarity and (when available) direction of travel. Unreliable matches are
 * flagged for manual verification instead of silently blocking a road.
 */
export async function matchDisruptionToSegments(input: {
  lat?: number | null;
  lng?: number | null;
  roadName?: string | null;
  description?: string;
  direction?: string;
}): Promise<SegmentMatch> {
  const segments = (await db.select().from(roadSegments)) as SegmentRow[];
  const candidates: SegmentCandidate[] = [];

  for (const segment of segments) {
    const line = segment.geometry.map(([lng, lat]: [number, number]) => ({ lat, lng }));
    let distanceMeters = Number.POSITIVE_INFINITY;
    if (input.lat !== undefined && input.lat !== null && input.lng !== undefined && input.lng !== null) {
      const point: LatLng = { lat: input.lat, lng: input.lng };
      distanceMeters = projectOnPolyline(point, line).distanceMeters;
      // Cheap pre-filter: skip segments whose bounding box is far away.
      const minLat = Math.min(segment.startLat, segment.endLat);
      const maxLat = Math.max(segment.startLat, segment.endLat);
      const minLng = Math.min(segment.startLng, segment.endLng);
      const maxLng = Math.max(segment.startLng, segment.endLng);
      if (point.lat < minLat - 0.05 || point.lat > maxLat + 0.05 || point.lng < minLng - 0.05 || point.lng > maxLng + 0.05) {
        distanceMeters = Number.POSITIVE_INFINITY;
      }
    }

    const nameScore = input.roadName ? nameSimilarity(input.roadName, segment.roadName) : 0;
    const proximityScore = Number.isFinite(distanceMeters) ? 1 / (1 + distanceMeters / 120) : 0;
    const score = proximityScore + nameScore * 2;
    if (score <= 0.05) continue;
    candidates.push({
      id: segment.id,
      roadName: segment.roadName,
      city: segment.city,
      distanceMeters: Number.isFinite(distanceMeters) ? Math.round(distanceMeters) : -1,
      nameScore: Number(nameScore.toFixed(2)),
      score: Number(score.toFixed(3)),
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 6);
  const strong = top.filter((candidate) => candidate.score >= 0.55 && (candidate.nameScore >= 0.5 || candidate.distanceMeters >= 0 && candidate.distanceMeters <= 250));

  if (strong.length === 0) {
    return {
      segmentIds: [],
      method: "none",
      confidence: 0,
      needsReview: true,
      candidates: top,
      resolvedLat: input.lat ?? null,
      resolvedLng: input.lng ?? null,
      notes:
        "No road segment could be matched reliably. The report is stored for manual verification and does not affect routing until confirmed.",
    };
  }

  const best = strong[0];
  const method: SegmentMatch["method"] = best.nameScore >= 0.5 && best.distanceMeters >= 0 && best.distanceMeters <= 250 ? "geometry+name" : best.distanceMeters >= 0 ? "geometry" : "name";
  const ambiguity = strong.length > 1 && strong[1].score > best.score * 0.85;
  const confidence = Number(Math.min(0.97, 0.45 + best.score * 0.4 + (method === "geometry+name" ? 0.12 : 0)).toFixed(2));

  return {
    segmentIds: strong.slice(0, 4).map((candidate) => candidate.id),
    method,
    confidence,
    needsReview: ambiguity || confidence < 0.6,
    candidates: top,
    resolvedLat: input.lat ?? null,
    resolvedLng: input.lng ?? null,
    notes: ambiguity
      ? `Multiple plausible segments (${strong.length}); flagged for manual verification.`
      : `Matched ${strong.length} segment(s) via ${method}.`,
  };
}

/** Nearest segment for a coordinate (used by manual reports). */
export async function findNearestSegmentRow(point: LatLng): Promise<SegmentRow | null> {
  const rows = await db.select().from(roadSegments);
  let best: { row: SegmentRow; distance: number } | null = null;
  for (const row of rows) {
    const line = row.geometry.map(([lng, lat]: [number, number]) => ({ lat, lng }));
    const distance = projectOnPolyline(point, line).distanceMeters;
    if (!best || distance < best.distance) best = { row, distance };
  }
  return best?.row ?? null;
}

export async function segmentById(id: number): Promise<SegmentRow | null> {
  const rows = await db.select().from(roadSegments).where(eq(roadSegments.id, id)).limit(1);
  return rows[0] ?? null;
}

export function distanceToSegment(point: LatLng, segment: SegmentRow): number {
  const line = segment.geometry.map(([lng, lat]: [number, number]) => ({ lat, lng }));
  return haversine(point, line[0]);
}
