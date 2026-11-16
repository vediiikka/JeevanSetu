/**
 * Route styling shared by every map.
 *   - The route being driven: solid green with a white outline (always on top).
 *   - Alternatives: solid coloured lines with a dark outline, drawn beneath the route.
 *   - Labels: one per option, with its name and ETA, placed along the line.
 * Traffic heatmap colours (green / orange / red) are used only for the roads around the route.
 */
import type { MapMarker, MapPolyline } from "@/components/MapCanvas";

export const ROUTE_GREEN = "#16a34a";
const ALT_COLOR: Record<string, string> = {
  fastest: "#2563eb",
  fast: "#a855f7",
  slow: "#0891b2",
};

export function altColor(key?: string | null): string {
  return (key && ALT_COLOR[key]) || "#2563eb";
}

export type StyledOption = {
  key?: string;
  label: string;
  geometry: [number, number][];
  durationSeconds: number;
  distanceMeters?: number;
};

function pickSelected<T extends StyledOption>(options: T[], selectedKey?: string | null): T | undefined {
  return options.find((o) => o.key && o.key === selectedKey) ?? options[0];
}

/** Map lines for a route and its alternatives. `driven` (the stored route) overrides the selected option's geometry. */
export function routeLines(
  options: StyledOption[],
  selectedKey: string | null | undefined,
  driven?: [number, number][] | null,
): MapPolyline[] {
  const selected = pickSelected(options, selectedKey);
  const selectedGeometry = driven && driven.length > 1 ? driven : selected?.geometry;
  const lines: MapPolyline[] = [];
  for (const option of options) {
    if (option === selected) continue;
    if (!option.geometry || option.geometry.length < 2) continue;
    lines.push({
      id: `route-alt-${option.key ?? option.label}`,
      coords: option.geometry,
      color: altColor(option.key),
      weight: 5,
      dashed: false,
      opacity: 0.92,
      casing: true,
      casingColor: "#0f172a",
    });
  }
  if (selectedGeometry && selectedGeometry.length > 1) {
    lines.push({
      id: "route-selected",
      coords: selectedGeometry,
      color: ROUTE_GREEN,
      weight: 7,
      dashed: false,
      opacity: 1,
      casing: true,
      casingColor: "#ffffff",
    });
  }
  return lines;
}

const LABEL_POSITIONS = [0.5, 0.34, 0.66];

/** One label per option: the selected route at mid-line, alternatives spread along their own lines. */
export function routeLabelMarkers(options: StyledOption[], selectedKey?: string | null): MapMarker[] {
  const selected = pickSelected(options, selectedKey);
  const alternatives = options.filter((o) => o !== selected);
  return options.flatMap((option): MapMarker[] => {
    if (!option.geometry || option.geometry.length < 2) return [];
    const isSelected = option === selected;
    const slot = isSelected ? 0 : alternatives.indexOf(option) + 1;
    const fraction = LABEL_POSITIONS[slot] ?? 0.5;
    const at = option.geometry[Math.min(option.geometry.length - 1, Math.floor((option.geometry.length - 1) * fraction))];
    const minutes = Math.max(1, Math.round(option.durationSeconds / 60));
    return [
      {
        id: `route-label-${option.key ?? option.label}`,
        lat: at[1],
        lng: at[0],
        kind: "pin",
        label: `${option.label} · ${minutes} min`,
        detail: `${option.distanceMeters ? `${(option.distanceMeters / 1000).toFixed(1)} km` : ""}${isSelected ? " · driving this route" : ""}`,
        tone: isSelected ? ROUTE_GREEN : altColor(option.key),
      },
    ];
  });
}
