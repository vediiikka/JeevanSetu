"use client";

import { useEffect, useRef, useState } from "react";
import MapView from "@/components/MapView";
import type { MapMarker, MapPolyline, MapVehicle } from "@/components/MapCanvas";
import { Alert, Badge, Card, EmptyState, SectionTitle, Spinner, StatCard } from "@/components/ui";
import DriverProfilePanel from "@/components/DriverProfilePanel";
import { api } from "@/lib/useLive";
import { formatDistance, formatDuration } from "@/lib/geo";
import { categoryIcon, categoryLabel, statusLabel } from "@/lib/domain";
import { TrafficLegend } from "@/components/TrafficLegend";
import { networkToLines, type MapTrafficLine, type TrafficSegmentView } from "@/lib/trafficView";
import { ROUTE_GREEN } from "@/lib/routeStyle";
import type { DriverListItem } from "@/lib/driverProfileTypes";

type Mission = "to_patient" | "to_hospital" | "at_hospital" | null;

type LiveAmbulance = {
  id: number;
  code: string;
  type: string;
  status: string;
  lat: number;
  lng: number;
  movementSource: string;
  lastSeenAt: string | null;
  updatedSecondsAgo: number | null;
  stage: string;
  stageLabel: string;
  nextStop: { kind: "patient" | "hospital"; name: string; lat: number; lng: number } | null;
  hospitalSelectedAfterPickup: boolean;
  timeline: { key: string; label: string; at: string | null }[];
  driver: { id: number; name: string; phone: string; status: string } | null;
  mission: Mission;
  request: {
    id: number;
    publicId: string;
    status: string;
    category: string;
    severity: string;
    patientName: string;
    pickup: { lat: number; lng: number; address: string };
    etaMinutes: number | null;
    distanceKm: number | null;
  } | null;
  hospital: { id: number; name: string; lat: number; lng: number } | null;
  route: {
    id: number;
    purpose: "pickup" | "hospital";
    geometry: [number, number][];
    durationSeconds: number;
    distanceMeters: number;
    createdAt: string;
    engine: string;
    optionKey: string | null;
    optionLabel: string | null;
    segments: TrafficSegmentView[];
  } | null;
  progress: number;
  speedKph: number;
  remainingMeters: number;
  remainingSeconds: number;
};

type LiveResponse = {
  generatedAt: string;
  summary: { total: number; moving: number; toPatient: number; toHospital: number; atHospital: number; available: number; offline: number };
  ambulances: LiveAmbulance[];
  drivers: DriverListItem[];
  hospitals: { id: number; name: string; lat: number; lng: number }[];
};

const MISSION_TONE: Record<string, string> = {
  to_patient: "#f59e0b",
  to_hospital: "#ef4444",
  at_hospital: "#38bdf8",
};

const MISSION_LABEL: Record<string, string> = {
  to_patient: "Driving to patient",
  to_hospital: "Patient on board → hospital",
  at_hospital: "At hospital",
};

const STAGE_TONE: Record<string, "red" | "amber" | "green" | "blue" | "slate"> = {
  assigned: "blue",
  to_patient: "amber",
  to_hospital: "red",
  at_hospital: "blue",
  available: "green",
  offline: "slate",
  idle: "slate",
};

const STAGE_LABEL: Record<string, string> = {
  assigned: "Assigned",
  to_patient: "To patient",
  to_hospital: "To hospital",
  at_hospital: "At hospital",
  available: "Available",
  offline: "Offline",
  idle: "Idle",
};

const SOURCE_LABEL: Record<string, string> = {
  driver: "Device GPS (on route)",
  engine: "Road route engine",
  simulation: "Simulation (demo)",
};

const DEVICE_FRESH_SECONDS = 600;

function ago(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)} min ago`;
}

/** Where to centre the map for a driver: their ambulance if they have one, else their device GPS. */
function pointForDriver(data: LiveResponse, id: number): [number, number] | null {
  const driver = data.drivers.find((d) => d.id === id);
  if (!driver) return null;
  const vehicle = driver.ambulanceId ? data.ambulances.find((a) => a.id === driver.ambulanceId) : undefined;
  if (vehicle) return [vehicle.lat, vehicle.lng];
  if (driver.deviceLat !== null && driver.deviceLng !== null) return [driver.deviceLat, driver.deviceLng];
  return null;
}

export default function AdminLiveTracking({
  driverId,
  onDriverChange,
}: {
  /** Controlled selection (set by the Drivers tab). When omitted the component keeps its own selection. */
  driverId?: number | null;
  onDriverChange?: (id: number | null) => void;
} = {}) {
  const [data, setData] = useState<LiveResponse | null>(null);
  const dataRef = useRef<LiveResponse | null>(null);
  dataRef.current = data;
  const [error, setError] = useState<string | null>(null);
  const [localDriverId, setLocalDriverId] = useState<number | null>(null);
  const selectedDriverId = driverId !== undefined ? driverId : localDriverId;
  const [focusPoint, setFocusPoint] = useState<[number, number] | null>(null);
  const [follow, setFollow] = useState(true);
  const [trafficOn, setTrafficOn] = useState(true);
  const [netTraffic, setNetTraffic] = useState<MapTrafficLine[]>([]);
  const hasData = data !== null;

  const chooseDriver = (id: number | null) => {
    setLocalDriverId(id);
    onDriverChange?.(id);
    setFollow(true);
    if (id !== null && dataRef.current) {
      const point = pointForDriver(dataRef.current, id);
      if (point) setFocusPoint(point);
    }
  };

  // Traffic heatmap around the selected driver (or the first moving ambulance), every 30 seconds.
  useEffect(() => {
    if (!trafficOn || !hasData) return;
    let cancelled = false;
    const load = () => {
      const current = dataRef.current;
      const point = current && selectedDriverId !== null ? pointForDriver(current, selectedDriverId) : null;
      const moving = current?.ambulances.find((a) => a.route);
      const [lat, lng] = point ?? (moving ? [moving.lat, moving.lng] : [23.0225, 72.5714]);
      void api<{ edges: { level: "green" | "orange" | "red"; points: [number, number][] }[] }>(
        `/api/traffic?lat=${lat}&lng=${lng}&radius=3000`,
      )
        .then((traffic) => {
          if (!cancelled) setNetTraffic(networkToLines(traffic.edges, "admin-net", 3, 0.45));
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [trafficOn, hasData, selectedDriverId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await api<LiveResponse>("/api/admin/live");
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Live feed unavailable");
      }
    };
    void load();
    const poll = setInterval(load, 2000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, []);

  if (!data) {
    return (
      <Card className="card-pad">
        {error ? <Alert tone="red">{error}</Alert> : <Spinner label="Connecting to the live fleet feed…" />}
      </Card>
    );
  }

  const ambulances = data.ambulances;
  const drivers = data.drivers;
  const selectedDriver = drivers.find((d) => d.id === selectedDriverId) ?? null;
  const selectedAmbulance = ambulances.find((a) => a.driver?.id === selectedDriverId) ?? null;
  const selectedId = selectedAmbulance?.id ?? null;
  const generatedAt = data.generatedAt;
  const onTripCount = drivers.filter((d) => d.stage === "to_patient" || d.stage === "to_hospital" || d.stage === "at_hospital" || d.stage === "assigned").length;

  // Ambulances on a road route glide along it between polls (client-side interpolation).
  const vehicles: MapVehicle[] = ambulances
    .filter((a) => a.route)
    .map((a) => ({
      id: String(a.id),
      geometry: a.route!.geometry,
      progress: a.progress,
      durationSeconds: a.route!.durationSeconds,
      updatedAt: generatedAt,
      label: `${a.code}${a.driver ? ` · ${a.driver.name}` : ""}`,
      detail: `${MISSION_LABEL[a.mission ?? "to_patient"] ?? ""} · ${Math.round(a.speedKph)} km/h`,
      tone: MISSION_TONE[a.mission ?? "to_patient"] ?? "#16a34a",
      showLabel: selectedId === null || selectedId === a.id,
    }));

  // Every driver's last device GPS report (fresh ones only) and the parked ambulances.
  const driverMarkers: MapMarker[] = drivers
    .filter((d) => d.deviceLat !== null && d.deviceLng !== null && d.deviceUpdatedSecondsAgo !== null && d.deviceUpdatedSecondsAgo < DEVICE_FRESH_SECONDS)
    .map((d) => ({
      id: `drv-${d.id}`,
      lat: d.deviceLat!,
      lng: d.deviceLng!,
      kind: "driver" as const,
      label: d.name.split(" ")[0],
      detail: `${d.name} · device GPS ${ago(d.deviceUpdatedSecondsAgo)} · ${d.stageLabel}`,
      tone: d.id === selectedDriverId ? "#2563eb" : d.status === "on_trip" ? "#f59e0b" : d.status === "online" ? "#16a34a" : "#64748b",
    }));

  const markers: MapMarker[] = [
    ...driverMarkers,
    ...ambulances
      .filter((a) => !a.route)
      .map((a) => ({
        id: `amb-${a.id}`,
        lat: a.lat,
        lng: a.lng,
        kind: "ambulance" as const,
        label: a.code,
        detail: `${a.driver?.name ?? "No driver"} · ${statusLabel(a.status)}`,
        tone: a.status === "available" ? "#16a34a" : a.status === "offline" ? "#64748b" : "#0ea5e9",
      })),
    ...data.hospitals.map((h) => ({
      id: `hosp-${h.id}`,
      lat: h.lat,
      lng: h.lng,
      kind: "hospital" as const,
      label: h.name.split(" ").slice(0, 2).join(" "),
      detail: h.name,
    })),
    ...ambulances
      .filter((a) => a.request && a.mission === "to_patient")
      .map((a) => ({
        id: `pickup-${a.request!.id}`,
        lat: a.request!.pickup.lat,
        lng: a.request!.pickup.lng,
        kind: "patient" as const,
        label: `${a.request!.publicId} patient`,
        detail: `${a.request!.patientName} · ${a.request!.pickup.address || "pickup"}`,
      })),
  ];

  const trafficLines: MapTrafficLine[] = trafficOn ? netTraffic : [];

  // The selected driver's route is drawn bold; every other route is drawn faded.
  const polylines: MapPolyline[] = ambulances
    .filter((a) => a.route)
    .map((a) => ({
      id: `route-${a.id}`,
      coords: a.route!.geometry,
      color: ROUTE_GREEN,
      weight: selectedId === a.id ? 7 : 4,
      dashed: false,
      opacity: selectedId !== null && selectedId !== a.id ? 0.35 : 0.95,
    }));

  const driverRowsView = drivers;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Drivers" value={drivers.length} hint={`${drivers.filter((d) => d.status !== "offline").length} on duty`} />
        <StatCard label="On a trip" value={onTripCount} tone="amber" hint="to patient or hospital" />
        <StatCard label="Moving now" value={data.summary.moving} tone="green" hint="on a road route" />
        <StatCard label="To hospital" value={data.summary.toHospital} tone="red" hint="patient on board" />
        <StatCard label="Available" value={data.summary.available} tone="blue" hint="idle at base" />
        <StatCard label="Offline" value={data.summary.offline} hint="not on duty" />
      </div>

      <Card className="card-pad">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[260px] flex-1">
            <label className="label" htmlFor="driver-select">
              Track a driver
            </label>
            <select
              id="driver-select"
              className="input"
              value={selectedDriverId ?? ""}
              onChange={(event) => chooseDriver(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">All drivers — show every driver on the map</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.ambulanceCode ?? "no vehicle"} · {d.stageLabel}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-sm" onClick={() => setTrafficOn((value) => !value)}>
              Traffic {trafficOn ? "on" : "off"}
            </button>
            {selectedDriverId !== null ? (
              <>
                <button type="button" className="btn btn-sm" onClick={() => setFollow((value) => !value)}>
                  {follow && selectedAmbulance ? "Following" : "Follow"}
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => chooseDriver(null)}>
                  Show all drivers
                </button>
              </>
            ) : null}
          </div>
        </div>
        {selectedDriver ? (
          <p className="mt-2 text-[11px] text-sky-300">
            Tracking {selectedDriver.name}
            {selectedAmbulance ? ` · ${selectedAmbulance.code} · ${selectedAmbulance.stageLabel}` : " · no ambulance assigned"}
          </p>
        ) : (
          <p className="mt-2 text-[11px] text-slate-500">
            Choose a driver to follow them, or view all {drivers.length} drivers on the map.
          </p>
        )}
      </Card>

      {error ? <Alert tone="red">Live feed interrupted: {error}. Showing the last received positions.</Alert> : null}

      <div className="admin-live-layout grid gap-5">
        <div className="admin-live-data-column space-y-4">
        <Card className="card-pad admin-live-driver-list">
          <SectionTitle title={`All drivers (${drivers.length})`} subtitle="Click a driver to track them on the map" />
          <div className="space-y-2">
            {driverRowsView.map((d) => {
              const vehicle = d.ambulanceId ? ambulances.find((a) => a.id === d.ambulanceId) ?? null : null;
              const pct = Math.round((vehicle?.route ? vehicle.progress : 0) * 100);
              const isSelected = selectedDriverId === d.id;
              const username = d.loginEmail ? d.loginEmail.split("@")[0] : null;
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => chooseDriver(d.id)}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                    isSelected ? "border-sky-500/70 bg-sky-500/10" : "border-slate-800 bg-slate-950/50 hover:border-slate-600"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-bold text-slate-100">
                        {d.name} <span className="font-normal text-slate-500">· {d.ambulanceCode ?? "no vehicle"}</span>
                      </p>
                      <p className="text-[11px] text-sky-300">{d.stageLabel}</p>
                    </div>
                    <Badge tone={STAGE_TONE[d.stage] ?? "slate"}>{STAGE_LABEL[d.stage] ?? statusLabel(d.status)}</Badge>
                  </div>
                  {vehicle?.route ? (
                    <>
                      <div className="mt-2 h-1.5 overflow-hidden rounded bg-slate-800">
                        <div className={`h-1.5 rounded ${vehicle.mission === "to_hospital" ? "bg-red-500" : "bg-amber-500"}`} style={{ width: `${pct}%` }} />
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
                        <span>{pct}% of route</span>
                        <span>{Math.round(vehicle.speedKph)} km/h</span>
                        <span>{formatDistance(vehicle.remainingMeters)} left</span>
                        <span>ETA {formatDuration(vehicle.remainingSeconds)}</span>
                      </div>
                    </>
                  ) : null}
                  <p className="mt-1 text-[10px] text-slate-500">
                    {username ? `login ${username} · ` : ""}
                    device GPS {ago(d.deviceUpdatedSecondsAgo)}
                    {vehicle ? ` · ${SOURCE_LABEL[vehicle.movementSource] ?? vehicle.movementSource}` : ""}
                  </p>
                </button>
              );
            })}
            {drivers.length === 0 ? <EmptyState title="No drivers registered" /> : null}
          </div>
        </Card>

        {selectedDriverId !== null ? (
          <DriverProfilePanel driverId={selectedDriverId} onClose={() => chooseDriver(null)} />
        ) : null}

        <Card className="card-pad">
          <SectionTitle
            title="Live trip status"
            subtitle="Every active trip · click a row to track its driver"
            right={<Badge tone="green">{ambulances.filter((a) => a.request).length} active</Badge>}
          />
          {ambulances.filter((a) => a.request).length === 0 ? (
            <EmptyState title="No active trips" hint="When an ambulance is dispatched it appears here with its live stage." />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Ambulance · driver</th>
                    <th>Stage</th>
                    <th>Next stop</th>
                    <th>Remaining</th>
                    <th>Last update</th>
                  </tr>
                </thead>
                <tbody>
                  {ambulances
                    .filter((a) => a.request)
                    .map((a) => (
                      <tr key={a.id} className="cursor-pointer" onClick={() => chooseDriver(a.driver?.id ?? null)}>
                        <td>
                          <p className="font-semibold">{a.request!.publicId}</p>
                          <p className="text-[10px] text-slate-500">
                            {a.request!.patientName} · {categoryIcon(a.request!.category)} {categoryLabel(a.request!.category)}
                          </p>
                        </td>
                        <td>
                          <p className="font-semibold">{a.code}</p>
                          <p className="text-[10px] text-slate-500">{a.driver?.name ?? "—"}</p>
                        </td>
                        <td>
                          <Badge tone={STAGE_TONE[a.stage] ?? "slate"}>{STAGE_LABEL[a.stage] ?? a.stage}</Badge>
                          <p className="mt-1 text-[10px] text-slate-400">{a.stageLabel}</p>
                        </td>
                        <td className="text-[11px]">
                          {a.nextStop ? (a.nextStop.kind === "patient" ? `🧍 ${a.nextStop.name}` : `🏥 ${a.nextStop.name}`) : "—"}
                        </td>
                        <td className="text-[11px]">
                          {a.route ? `${formatDistance(a.remainingMeters)} · ${formatDuration(a.remainingSeconds)}` : "—"}
                        </td>
                        <td className="text-[11px] text-slate-400">
                          {a.updatedSecondsAgo !== null ? `${a.updatedSecondsAgo}s ago` : "—"}
                          <br />
                          {SOURCE_LABEL[a.movementSource] ?? a.movementSource}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        </div>

        <Card className="card-pad admin-live-map-panel">
          <SectionTitle
            title="Live driver map"
            subtitle="Every ambulance on its road route · driver device positions · refreshed every 2 s"
            right={<Badge tone="green">Live</Badge>}
          />
          <MapView
            center={[22.9, 72.6]}
            zoom={8}
            markers={markers}
            polylines={polylines}
            vehicles={vehicles}
            trafficLines={trafficLines}
            followId={follow && selectedId !== null ? String(selectedId) : null}
            flyTo={focusPoint}
            fitKey="route"
            className="admin-tracking-map"
          />
          <div className="mt-2">
            <TrafficLegend compact />
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-slate-500">
            <span>🟩 green line = route the ambulance is driving</span>
            <span>🚑 ambulance (arrow = direction of travel)</span>
            <span>🧑‍✈️ driver device GPS (last report)</span>
            <span>🏥 hospital</span>
          </div>
        </Card>

      </div>
    </div>
  );
}
