"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { Circle, CircleMarker, MapContainer, Marker, Polyline, Popup, TileLayer, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { computeVehiclePose, type VehiclePose } from "@/lib/movingPoint";
import { TRAFFIC_COLORS, type MapTrafficLine } from "@/lib/trafficView";

export type MapMarker = {
  id: string;
  lat: number;
  lng: number;
  kind: "ambulance" | "patient" | "hospital" | "disruption" | "driver" | "pin";
  label?: string;
  detail?: string;
  tone?: string;
};

export type MapVehicle = {
  id?: string;
  tone?: string;
  showLabel?: boolean;
  geometry: [number, number][];
  progress: number;
  durationSeconds: number | null;
  updatedAt: string | null;
  label?: string;
  detail?: string;
};

export type MapPolyline = {
  id: string;
  /** Draw a contrasting outline beneath the line (used for the route and its alternatives). */
  casing?: boolean;
  casingColor?: string;
  coords: [number, number][];
  color: string;
  weight?: number;
  dashed?: boolean;
  opacity?: number;
};

export type MapCircle = {
  id: string;
  lat: number;
  lng: number;
  radius: number;
  color: string;
  label?: string;
  detail?: string;
};

type MapTheme = "light" | "dark";
const MAP_THEME_STORAGE_KEY = "jeevansetu-map-theme";

function getInitialMapTheme(): MapTheme {
  if (typeof window === "undefined") return "light";
  const savedTheme = window.localStorage.getItem(MAP_THEME_STORAGE_KEY);
  if (savedTheme === "light" || savedTheme === "dark") return savedTheme;
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

const KIND_STYLE: Record<string, { bg: string; icon: string; size: number }> = {
  ambulance: { bg: "#dc2626", icon: "🚑", size: 30 },
  patient: { bg: "#f59e0b", icon: "🧍", size: 28 },
  hospital: { bg: "#0ea5e9", icon: "🏥", size: 30 },
  disruption: { bg: "#a855f7", icon: "⚠️", size: 24 },
  driver: { bg: "#22c55e", icon: "🧑‍✈️", size: 26 },
  pin: { bg: "#ef4444", icon: "📍", size: 26 },
};

function ClickHandler({ onClick }: { onClick?: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(event) {
      onClick?.(event.latlng.lat, event.latlng.lng);
    },
  });
  return null;
}

function Focus({ target, zoom = 14 }: { target: [number, number] | null; zoom?: number }) {
  const map = useMap();
  const targetLat = target?.[0];
  const targetLng = target?.[1];
  useEffect(() => {
    if (targetLat === undefined || targetLng === undefined) return;
    map.flyTo([targetLat, targetLng], zoom, { duration: 0.8 });
  }, [map, targetLat, targetLng, zoom]);
  return null;
}

function FitBounds({ coords }: { coords: [number, number][] }) {
  const map = useMap();
  const key = useMemo(() => coords.map((c) => `${c[0].toFixed(3)},${c[1].toFixed(3)}`).join(";"), [coords]);
  useEffect(() => {
    if (coords.length < 2) return;
    map.fitBounds(L.latLngBounds(coords), { padding: [40, 40], maxZoom: 15 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

function MovingVehicle({ vehicle, follow }: { vehicle: MapVehicle; follow?: boolean }) {
  const tone = vehicle.tone ?? "#16a34a";
  const map = useMap();
  const vehicleRef = useRef(vehicle);
  vehicleRef.current = vehicle;
  const [pose, setPose] = useState<VehiclePose | null>(() =>
    computeVehiclePose(vehicle.geometry, vehicle.progress, vehicle.durationSeconds, vehicle.updatedAt),
  );
  const lastPan = useRef(0);

  useEffect(() => {
    let frame = 0;
    let lastPaint = 0;
    const loop = (time: number) => {
      if (time - lastPaint > 70) {
        lastPaint = time;
        const current = vehicleRef.current;
        setPose(computeVehiclePose(current.geometry, current.progress, current.durationSeconds, current.updatedAt));
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!follow || !pose) return;
    const now = Date.now();
    if (now - lastPan.current < 60) return;
    lastPan.current = now;
    // No CSS transition: the centre is re-set every animation frame, which keeps
    // the camera glued to the vehicle instead of stepping between positions.
    map.panTo([pose.position.lat, pose.position.lng], { animate: false });
  }, [follow, pose, map]);

  if (!pose) return null;

  const icon = L.divIcon({
    className: "js-vehicle-icon",
    html: `<div class="js-vehicle"><div class="js-vehicle-arrow" style="transform: rotate(${pose.heading}deg);color:${tone}">▲</div><div class="js-vehicle-body" style="background:${tone}">🚑</div></div>${
      vehicle.showLabel && vehicle.label
        ? `<div class="js-marker-label js-vehicle-label" style="position:absolute;left:50%;top:40px;transform:translateX(-50%)">${vehicle.label}</div>`
        : ""
    }`,
    iconSize: [38, 38],
    iconAnchor: [19, 19],
  });

  return (
    <>
      <Marker position={[pose.position.lat, pose.position.lng]} icon={icon} zIndexOffset={1000}>
        <Popup>
          <div className="space-y-1">
            <p className="text-xs font-bold uppercase tracking-wide text-emerald-300">live ambulance</p>
            <p className="text-sm font-semibold">{vehicle.label ?? "Ambulance"}</p>
            <p className="text-xs text-slate-300">{vehicle.detail ?? ""}</p>
            <p className="text-[11px] text-slate-400">
              {Math.round(pose.speedKph)} km/h · {Math.round(pose.progress * 100)}% of route ·{" "}
              {Math.round(pose.remainingMeters)} m remaining
            </p>
            <p className="text-[10px] text-slate-500">
              {pose.position.lat.toFixed(5)}, {pose.position.lng.toFixed(5)} · heading {Math.round(pose.heading)}°
            </p>
          </div>
        </Popup>
      </Marker>
      <CircleMarker
        center={[pose.position.lat, pose.position.lng]}
        radius={16}
        pathOptions={{ color: "#22c55e", weight: 2, fillColor: "#22c55e", fillOpacity: 0.18 }}
      />
    </>
  );
}

export default function MapCanvas({
  center = [23.0225, 72.5714],
  zoom = 12,
  markers = [],
  polylines = [],
  circles = [],
  trafficLines = [],
  vehicle = null,
  followVehicle = false,
  vehicles = [],
  followId = null,
  onMapClick,
  flyTo,
  fitKey,
  className = "h-[420px] w-full",
  showLabels = true,
}: {
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
}) {
  const fitCoords = useMemo<[number, number][]>(() => {
    if (!fitKey) return [];
    return polylines
      .filter((p) => p.id.startsWith(fitKey))
      .flatMap((p) => p.coords.map(([lng, lat]) => [lat, lng] as [number, number]));
  }, [fitKey, polylines]);
  const [mapTheme, setMapTheme] = useState<MapTheme>(getInitialMapTheme);
  const nextMapTheme = mapTheme === "light" ? "dark" : "light";

  return (
    <div className={`map-canvas map-theme-${mapTheme} relative overflow-hidden rounded-xl border border-slate-800 ${className}`}>
      <MapContainer
        center={center}
        zoom={zoom}
        scrollWheelZoom
        className="h-full w-full"
        zoomControl
        attributionControl
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          maxZoom={19}
        />
        <ClickHandler onClick={onMapClick} />
        {flyTo ? <Focus target={flyTo} /> : null}
        {fitCoords.length > 1 ? <FitBounds coords={fitCoords} /> : null}

        {/* 1. Traffic heatmap of nearby roads (underneath everything). */}
        {trafficLines.map((line) => (
          <Polyline
            key={line.id}
            positions={line.paths.map((path) => path.map(([lng, lat]) => [lat, lng] as [number, number]))}
            pathOptions={{
              color: TRAFFIC_COLORS[line.level],
              weight: line.weight ?? 6,
              opacity: line.opacity ?? 0.9,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
        ))}

        {/* 2. Outlines for the route and its alternatives. */}
        {polylines.filter((line) => line.casing).map((line) => (
          <Polyline
            key={`${line.id}-outline`}
            positions={line.coords.map(([lng, lat]) => [lat, lng] as [number, number])}
            pathOptions={{
              color: line.casingColor ?? "#ffffff",
              weight: (line.weight ?? 5) + 3,
              opacity: 0.95,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
        ))}
        {/* 3. Alternatives first, then the chosen route last so it is always on top. */}
        {polylines.map((line) => (
          <Polyline
            key={line.id}
            positions={line.coords.map(([lng, lat]) => [lat, lng] as [number, number])}
            pathOptions={{
              color: line.color,
              weight: line.weight ?? 5,
              opacity: line.opacity ?? 0.95,
              dashArray: line.dashed ? "8 8" : undefined,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
        ))}

        {circles.map((circle) => (
          <Circle
            key={circle.id}
            center={[circle.lat, circle.lng]}
            radius={circle.radius}
            pathOptions={{ color: circle.color, weight: 1.5, fillColor: circle.color, fillOpacity: 0.12 }}
          >
            {circle.label ? <Popup>{circle.label}</Popup> : null}
          </Circle>
        ))}

        {markers.map((marker) => {
          const style = KIND_STYLE[marker.kind] ?? KIND_STYLE.pin;
          const icon = L.divIcon({
            className: "js-div-icon",
            html: `<div class="js-marker" style="width:${style.size}px;height:${style.size}px;background:${marker.tone ?? style.bg}">${style.icon}</div>${
              showLabels && marker.label
                ? `<div class="js-marker-label" style="transform:translate(-50%, 2px)">${marker.label}</div>`
                : ""
            }`,
            iconSize: [style.size, style.size],
            iconAnchor: [style.size / 2, style.size / 2],
          });
          return (
            <Marker key={marker.id} position={[marker.lat, marker.lng]} icon={icon}>
              <Popup>
                <div className="space-y-1">
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-300">{marker.kind}</p>
                  <p className="text-sm font-semibold">{marker.label ?? "Location"}</p>
                  {marker.detail ? <p className="text-xs text-slate-400">{marker.detail}</p> : null}
                  <p className="text-[10px] text-slate-500">
                    {marker.lat.toFixed(5)}, {marker.lng.toFixed(5)}
                  </p>
                </div>
              </Popup>
            </Marker>
          );
        })}

        {vehicle ? <MovingVehicle vehicle={vehicle} follow={followVehicle} /> : null}
        {vehicles.map((item, index) => (
          <MovingVehicle
            key={item.id ?? `vehicle-${index}`}
            vehicle={item}
            follow={Boolean(followId && item.id === followId)}
          />
        ))}

        {markers.length === 1 ? (
          <CircleMarker
            center={[markers[0].lat, markers[0].lng]}
            radius={9}
            pathOptions={{ color: "#f8fafc", weight: 1, fillColor: "#ef4444", fillOpacity: 0.25 }}
          />
        ) : null}
      </MapContainer>
      <button
        type="button"
        className="map-theme-toggle"
        aria-label={`Switch map to ${nextMapTheme} mode`}
        title={`Switch map to ${nextMapTheme} mode`}
        onClick={() => {
          setMapTheme(nextMapTheme);
          window.localStorage.setItem(MAP_THEME_STORAGE_KEY, nextMapTheme);
        }}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
          {mapTheme === "light" ? (
            <>
              <circle cx="10" cy="10" r="3.3" stroke="currentColor" strokeWidth="1.7" />
              <path d="M10 1.8v2M10 16.2v2M18.2 10h-2M3.8 10h-2m14-5.8-1.4 1.4M5.6 14.4l-1.4 1.4m11.6 0-1.4-1.4M5.6 5.6 4.2 4.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </>
          ) : (
            <path d="M16.4 12.7A6.8 6.8 0 0 1 7.3 3.6a6.8 6.8 0 1 0 9.1 9.1Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          )}
        </svg>
        <span>{mapTheme === "light" ? "Dark map" : "Light map"}</span>
      </button>
    </div>
  );
}
