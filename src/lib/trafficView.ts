/**
 * Client-safe helpers for the traffic heatmap and the route option colours.
 * Coordinates are [lng, lat] (GeoJSON order) everywhere in this file.
 */
export type TrafficLevel = "green" | "orange" | "red";
export type TrafficSegmentView = { level: TrafficLevel; points: [number, number][] };
export type MapTrafficLine = {
  id: string;
  level: TrafficLevel;
  paths: [number, number][][];
  weight?: number;
  opacity?: number;
};

export const TRAFFIC_COLORS: Record<TrafficLevel, string> = {
  green: "#22c55e",
  orange: "#f97316",
  red: "#ef4444",
};

export const TRAFFIC_LABELS: Record<TrafficLevel, string> = {
  green: "Free flow",
  orange: "Moderate / slowing",
  red: "Heavy / congested",
};

export const OPTION_COLORS: Record<string, string> = {
  fastest: "#2563eb",
  fast: "#a855f7",
  slow: "#64748b",
};

export function optionColor(key: string | null | undefined): string {
  if (!key) return "#2563eb";
  return OPTION_COLORS[key] ?? "#38bdf8";
}

/** Groups coloured route pieces into at most three map layers (one per congestion level). */
export function segmentsToLines(
  segments: TrafficSegmentView[] | null | undefined,
  idPrefix: string,
  weight: number,
  opacity: number,
): MapTrafficLine[] {
  if (!segments || segments.length === 0) return [];
  const byLevel: Record<TrafficLevel, [number, number][][]> = { green: [], orange: [], red: [] };
  for (const segment of segments) {
    if (segment.points.length >= 2) byLevel[segment.level].push(segment.points);
  }
  return (["green", "orange", "red"] as TrafficLevel[])
    .filter((level) => byLevel[level].length > 0)
    .map((level) => ({ id: `${idPrefix}-${level}`, level, paths: byLevel[level], weight, opacity }));
}

/** Same grouping for the surrounding road network (edges as {level, points}). */
export function networkToLines(
  edges: { level: TrafficLevel; points: [number, number][] }[] | null | undefined,
  idPrefix: string,
  weight: number,
  opacity: number,
): MapTrafficLine[] {
  return segmentsToLines(edges ?? [], idPrefix, weight, opacity);
}
