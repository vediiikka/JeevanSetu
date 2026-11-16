"use client";

import dynamic from "next/dynamic";
import type { MapCircle, MapMarker, MapPolyline, MapVehicle } from "@/components/MapCanvas";
import type { MapTrafficLine } from "@/lib/trafficView";

const MapCanvas = dynamic(() => import("@/components/MapCanvas"), {
  ssr: false,
  loading: () => (
    <div className="grid h-[420px] w-full place-items-center rounded-xl border border-slate-800 bg-slate-900/60 text-xs text-slate-500">
      Loading map…
    </div>
  ),
});

export type MapViewProps = {
  center?: [number, number];
  zoom?: number;
  markers?: MapMarker[];
  polylines?: MapPolyline[];
  circles?: MapCircle[];
  trafficLines?: MapTrafficLine[];
  vehicle?: MapVehicle | null;
  followVehicle?: boolean;
  vehicles?: MapVehicle[];
  followId?: string | null;
  onMapClick?: (lat: number, lng: number) => void;
  flyTo?: [number, number] | null;
  fitKey?: string;
  className?: string;
  showLabels?: boolean;
};

export default function MapView(props: MapViewProps) {
  return <MapCanvas {...props} />;
}
