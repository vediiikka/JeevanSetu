"use client";

import { Badge } from "@/components/ui";
import { formatDistance, formatDuration } from "@/lib/geo";
import { TRAFFIC_COLORS } from "@/lib/trafficView";
import { ROUTE_GREEN, altColor } from "@/lib/routeStyle";

export type RouteOptionView = {
  key?: string;
  label: string;
  durationSeconds: number;
  distanceMeters: number;
  delaySeconds: number;
  traffic: string;
  algorithm?: string;
  overlapWithFastest?: number;
  nodesExpanded?: number;
  computeMs?: number;
  roadNames?: string[];
  distinct?: boolean;
  trafficMix?: { green: number; orange: number; red: number };
};

const TRAFFIC_TONE: Record<string, "green" | "amber" | "red"> = {
  low: "green",
  moderate: "amber",
  heavy: "red",
  severe: "red",
};

function shortAlgorithm(algorithm?: string): string {
  if (!algorithm) return "road routing";
  if (algorithm.startsWith("A*")) return "A* search";
  if (algorithm.startsWith("Dijkstra")) return "Dijkstra search";
  return algorithm.split(" (")[0];
}

/** The three route options: time, distance, traffic on the route, and the algorithm that found it. */
export function RouteOptionCards({
  options,
  selectedKey,
  onSelect,
  busyKey,
  provider,
}: {
  options: RouteOptionView[];
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  busyKey?: string | null;
  /** Routing engine that produced the options: "osm-graph" gives three options; anything else is the fallback. */
  provider?: string | null;
}) {
  if (options.length === 0) return null;
  const fallback = Boolean(provider) && provider !== "osm-graph" && options.length < 3;
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((option) => {
          const key = option.key ?? option.label;
          const selected = Boolean(selectedKey) && selectedKey === option.key;
          const mix = option.trafficMix;
          return (
            <div
              key={key}
              className={`relative overflow-hidden rounded-lg border bg-slate-950/60 p-2.5 ${
                selected ? "border-emerald-400/70 ring-1 ring-emerald-400/30" : "border-slate-800"
              }`}
            >
              <span className="absolute inset-x-0 top-0 h-1.5" style={{ background: selected ? ROUTE_GREEN : altColor(option.key) }} />
              <div className="mt-1 flex items-center justify-between gap-2">
                <p className="text-[11px] font-bold uppercase tracking-wide text-slate-200">{option.label}</p>
                <Badge tone={TRAFFIC_TONE[option.traffic] ?? "slate"}>{option.traffic}</Badge>
              </div>
              <p className="mt-1 text-lg font-bold tabular-nums text-white">{formatDuration(option.durationSeconds)}</p>
              <p className="text-[11px] text-slate-400">
                {formatDistance(option.distanceMeters)} · {option.delaySeconds > 0 ? `+${formatDuration(option.delaySeconds)} traffic` : "no traffic delay"}
              </p>
              {mix ? (
                <div className="mt-2">
                  <div className="flex h-1.5 overflow-hidden rounded-full bg-slate-800">
                    <span style={{ width: `${mix.green}%`, background: TRAFFIC_COLORS.green }} />
                    <span style={{ width: `${mix.orange}%`, background: TRAFFIC_COLORS.orange }} />
                    <span style={{ width: `${mix.red}%`, background: TRAFFIC_COLORS.red }} />
                  </div>
                  <p className="mt-1 text-[10px] text-slate-500">
                    Traffic on route: {mix.green}% free · {mix.orange}% slowing · {mix.red}% heavy
                  </p>
                </div>
              ) : null}
              {option.roadNames && option.roadNames.length > 0 ? (
                <p className="mt-1 line-clamp-2 text-[10px] text-slate-500">via {option.roadNames.slice(0, 3).join(" · ")}</p>
              ) : null}
              <p className="mt-1 text-[10px] text-slate-500">
                {shortAlgorithm(option.algorithm)}
                {option.nodesExpanded ? ` · ${option.nodesExpanded.toLocaleString()} junctions · ${option.computeMs ?? 0} ms` : ""}
                {option.overlapWithFastest !== undefined && option.key !== "fastest"
                  ? ` · ${Math.round((1 - option.overlapWithFastest) * 100)}% different roads`
                  : ""}
              </p>
              {selected ? (
                <p className="mt-2 text-[11px] font-semibold text-emerald-300">✓ Ambulance is driving this route</p>
              ) : onSelect ? (
                <button
                  type="button"
                  className="btn btn-sm mt-2 w-full"
                  disabled={busyKey !== null && busyKey !== undefined}
                  onClick={() => onSelect(key)}
                >
                  {busyKey === option.key ? "Selecting…" : "Use this route"}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {fallback ? (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
          <p className="font-semibold">Only {options.length} route found — the road network is not loaded on this computer.</p>
          <p className="mt-1">
            The app is using the road service instead, which returns one route. To see the fastest, little-fast and slow
            options: restore <code className="text-amber-100">data/road-graph/gujarat-osm.json.gz</code> into the project, or run{" "}
            <code className="text-amber-100">node scripts/build-road-graph.mjs</code> (needs internet, takes a few minutes), then restart the server.
          </p>
        </div>
      ) : null}
      <p className="text-[11px] text-slate-500">
        <span className="font-semibold text-emerald-300">Green line</span> = the route the ambulance drives.
        Coloured lines = alternatives. The heatmap shows traffic on nearby roads.
        {options.length < 3 ? ` Only ${options.length} distinct route${options.length === 1 ? "" : "s"} found for this trip.` : ""}
      </p>
    </div>
  );
}
