"use client";

import { TRAFFIC_COLORS, TRAFFIC_LABELS } from "@/lib/trafficView";

/** Legend for the traffic heatmap. Always labelled as estimated, never as live sensor data. */
export function TrafficLegend({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${compact ? "text-[10px]" : "text-[11px]"} text-slate-400`}>
      <span className="font-semibold uppercase tracking-wide text-slate-300">Traffic</span>
      {(["green", "orange", "red"] as const).map((level) => (
        <span key={level} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-5 rounded-full" style={{ background: TRAFFIC_COLORS[level] }} />
          {TRAFFIC_LABELS[level]}
        </span>
      ))}
      <span className="basis-full text-[10px] text-slate-500">
        Estimated from time of day, road type and reported incidents. Not live sensor data.
      </span>
    </div>
  );
}
