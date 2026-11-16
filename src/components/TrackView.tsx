"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import MapView from "@/components/MapView";
import { Alert, Badge, Card, EmptyState, KeyValue, ProgressSteps, SectionTitle, Spinner } from "@/components/ui";
import { api } from "@/lib/useLive";
import { formatDistance, formatDuration, formatEta } from "@/lib/geo";
import { useVehiclePose } from "@/lib/movingPoint";
import { RouteOptionCards } from "@/components/RouteOptionCards";
import { TrafficLegend } from "@/components/TrafficLegend";
import { networkToLines, type MapTrafficLine, type TrafficSegmentView } from "@/lib/trafficView";
import { routeLabelMarkers, routeLines } from "@/lib/routeStyle";
import { categoryIcon, categoryLabel, disruptionIcon, statusLabel, STATUS_TONE } from "@/lib/domain";

type TrackDetail = {
  route?: { trafficSummary?: { key?: string; label?: string; segments?: TrafficSegmentView[] } } | null;
  request: {
    id: number;
    publicId: string;
    status: string;
    category: string;
    severity: string;
    mode: string;
    patientName: string;
    pickupLat: number;
    pickupLng: number;
    pickupAddress: string;
    etaMinutes: number | null;
    distanceKm: number | null;
    createdAt: string;
  };
  hospital: { id: number; name: string; address: string; lat: number; lng: number } | null;
  ambulance: { id: number; code: string; type: string; status: string; lat: number; lng: number } | null;
  driver: { id: number; name: string; phone: string } | null;
  ambulanceProgress?: number;
  routeDurationSeconds?: number | null;
  ambulanceUpdatedAt?: string | null;
  plan: {
    provider?: string;
    options: {
      label: string;
      trafficMix?: { green: number; orange: number; red: number };
      key?: string;
      algorithm?: string;
      overlapWithFastest?: number;
      nodesExpanded?: number;
      computeMs?: number;
      segments?: TrafficSegmentView[];
      geometry: [number, number][];
      distanceMeters: number;
      durationSeconds: number;
      delaySeconds: number;
      traffic: string;
      roadNames: string[];
    }[];
    fastest: {
      label: string;
      geometry: [number, number][];
      distanceMeters: number;
      durationSeconds: number;
      delaySeconds: number;
      traffic: string;
      roadNames: string[];
    } | null;
    generatedAt: string;
  } | null;
  disruptions: {
    id: number;
    title: string;
    type: string;
    severity: string;
    lat: number;
    lng: number;
    confidence?: number;
    verification?: string;
    sourceName?: string | null;
  }[];
};

const FLOW = ["assigned", "enroute_pickup", "arrived_pickup", "enroute_hospital", "arrived_hospital", "completed"];

export default function TrackView({ publicId }: { publicId: string }) {
  const [detail, setDetail] = useState<TrackDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Hook runs unconditionally, before the loading/error early returns.
  const vehiclePose = useVehiclePose(
    detail?.plan?.fastest?.geometry ?? null,
    detail?.ambulanceProgress ?? 0,
    detail?.routeDurationSeconds ?? null,
    detail?.ambulanceUpdatedAt ?? null,
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api<{ detail: TrackDetail }>(`/api/requests/${publicId}`);
        if (!cancelled) setDetail(data.detail);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Request not found");
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [publicId]);

  const activeGeometry = detail?.plan?.fastest?.geometry ?? null;
  const ambulanceRemaining = vehiclePose
    ? { meters: vehiclePose.remainingMeters, seconds: vehiclePose.remainingSeconds }
    : null;

  const markers = useMemo(() => {
    if (!detail) return [];
    const list: {
      id: string;
      lat: number;
      lng: number;
      kind: "ambulance" | "patient" | "hospital" | "disruption";
      label?: string;
      detail?: string;
    }[] = [
      {
        id: "pickup",
        lat: detail.request.pickupLat,
        lng: detail.request.pickupLng,
        kind: "patient",
        label: "Patient",
        detail: detail.request.pickupAddress || "GPS location",
      },
    ];
    if (detail.hospital) {
      list.push({
        id: "hospital",
        lat: detail.hospital.lat,
        lng: detail.hospital.lng,
        kind: "hospital",
        label: detail.hospital.name,
        detail: detail.hospital.address,
      });
    }
    for (const disruption of detail.disruptions) {
      list.push({
        id: `disruption-${disruption.id}`,
        lat: disruption.lat,
        lng: disruption.lng,
        kind: "disruption",
        label: disruption.title,
        detail: `${disruption.severity} severity`,
      });
    }
    return list;
  }, [detail]);

  const selectedKey = detail?.route?.trafficSummary?.key ?? "fastest";
  const polylines = useMemo(
    () => routeLines(detail?.plan?.options ?? [], selectedKey, null),
    [detail, selectedKey],
  );

  const [trafficOn, setTrafficOn] = useState(true);
  const [netTraffic, setNetTraffic] = useState<MapTrafficLine[]>([]);
  const pickupLat = detail?.request.pickupLat;
  const pickupLng = detail?.request.pickupLng;
  useEffect(() => {
    if (!trafficOn || pickupLat === undefined || pickupLng === undefined) return;
    let cancelled = false;
    const load = () =>
      api<{ edges: { level: "green" | "orange" | "red"; points: [number, number][] }[] }>(
        `/api/traffic?lat=${pickupLat}&lng=${pickupLng}&radius=2500`,
      )
        .then((data) => {
          if (!cancelled) setNetTraffic(networkToLines(data.edges, "track-net", 3, 0.45));
        })
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [trafficOn, pickupLat, pickupLng]);

  const trafficLines = useMemo<MapTrafficLine[]>(() => (trafficOn ? netTraffic : []), [trafficOn, netTraffic]);

  if (error) {
    return (
      <Card className="card-pad">
        <Alert tone="red">{error}</Alert>
        <Link href="/patient" className="btn btn-sm mt-3">
          Back to emergency request
        </Link>
      </Card>
    );
  }

  if (!detail) {
    return (
      <Card className="card-pad">
        <Spinner label="Loading live tracking…" />
      </Card>
    );
  }

  const statusIndex = Math.max(0, FLOW.indexOf(detail.request.status));
  const fastest = detail.plan?.fastest ?? null;

  return (
    <div className="tracking-layout grid gap-5">
      <div className="space-y-4">
        {detail?.plan && detail.plan.options.length > 0 ? (
          <Card className="card-pad">
            <SectionTitle title="Route options" subtitle="Fastest, little fast and slow alternative" />
            <RouteOptionCards options={detail.plan.options} selectedKey={selectedKey} provider={detail.plan.provider} />
          </Card>
        ) : null}
        <Card className="card-pad">
          <SectionTitle title="Status" subtitle="Updated every 5 seconds" />
          <KeyValue label="Ambulance" value={detail.ambulance ? `${detail.ambulance.code} (${detail.ambulance.type})` : "Assigning…"} />
          <KeyValue label="Driver" value={detail.driver ? `${detail.driver.name} · ${detail.driver.phone}` : "—"} />
          <KeyValue label="ETA" value={formatEta(detail.request.etaMinutes)} />
          <KeyValue
            label="Ambulance"
            value={
              ambulanceRemaining
                ? `moving · ${formatDistance(ambulanceRemaining.meters)} to go`
                : detail.ambulance
                  ? "on route"
                  : "assigning…"
            }
          />
          <KeyValue label="Distance" value={detail.request.distanceKm ? `${detail.request.distanceKm} km` : "—"} />
          <KeyValue label="Hospital" value={detail.hospital?.name ?? "—"} />
          <KeyValue label="Mode" value={detail.request.mode === "nearest" ? "Nearest suitable" : "Desired hospital"} />
        </Card>

        {fastest ? (
          <Card className="card-pad">
            <SectionTitle title="Current route" subtitle={`Generated ${new Date(detail.plan!.generatedAt).toLocaleTimeString()}`} />
            <p className="text-sm font-semibold text-slate-100">{fastest.label}</p>
            <p className="text-xs text-slate-400">
              {formatDistance(fastest.distanceMeters)} · {formatDuration(fastest.durationSeconds)} ·{" "}
              {fastest.traffic} traffic
              {fastest.delaySeconds > 0 ? ` · +${formatDuration(fastest.delaySeconds)} delay` : ""}
            </p>
            <p className="mt-1 text-[11px] text-slate-500">Via {fastest.roadNames.slice(0, 5).join(" · ")}</p>
            {detail.plan && detail.plan.options.length > 1 ? (
              <div className="mt-2 space-y-1">
                {detail.plan.options.slice(1).map((option) => (
                  <p key={option.label} className="text-[11px] text-sky-300">
                    {option.label}: {formatDuration(option.durationSeconds)} · {formatDistance(option.distanceMeters)}
                  </p>
                ))}
              </div>
            ) : null}
          </Card>
        ) : null}

        {detail.disruptions.length > 0 ? (
          <Card className="card-pad">
            <SectionTitle title="Road conditions" subtitle="Active disruptions in the coverage area" />
            <ul className="space-y-1">
              {detail.disruptions.slice(0, 6).map((disruption) => (
                <li key={disruption.id} className="text-[11px] text-slate-400">
                  {disruptionIcon(disruption.type)} {disruption.title}{" "}
                  <span className="text-slate-600">
                    ({disruption.severity} · confidence {Math.round((disruption.confidence ?? 1) * 100)}% ·{" "}
                    {disruption.verification ?? "verified"} · {disruption.sourceName ?? "source"})
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <EmptyState title="No active disruptions" hint="Network is clear." />
        )}
      </div>

      <Card className="card-pad tracking-map-card">
        <SectionTitle
          title={`Live tracking · ${detail.request.publicId}`}
          subtitle={`${categoryIcon(detail.request.category)} ${categoryLabel(detail.request.category)} · ${detail.request.severity}`}
          right={<Badge tone={STATUS_TONE[detail.request.status] ?? "slate"}>{statusLabel(detail.request.status)}</Badge>}
        />
        <MapView
          vehicle={
            detail.ambulance && activeGeometry
              ? {
                  geometry: activeGeometry,
                  progress: detail.ambulanceProgress ?? 0,
                  durationSeconds: detail.routeDurationSeconds ?? null,
                  updatedAt: detail.ambulanceUpdatedAt ?? null,
                  label: detail.ambulance.code,
                  detail: `${detail.ambulance.type} · ${Math.round(vehiclePose?.speedKph ?? 0)} km/h`,
                }
              : null
          }
          center={[detail.request.pickupLat, detail.request.pickupLng]}
          zoom={13}
          markers={[...markers, ...routeLabelMarkers(detail?.plan?.options ?? [], selectedKey)]}
          polylines={polylines}
          trafficLines={trafficLines}
          fitKey={polylines.length > 0 ? "route" : undefined}
          className="tracking-live-map"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <TrafficLegend compact />
          <button type="button" className="btn btn-sm" onClick={() => setTrafficOn((value) => !value)}>
            Traffic {trafficOn ? "on" : "off"}
          </button>
        </div>
        <div className="mt-3">
          <ProgressSteps
            steps={["Assigned", "To pickup", "Pickup", "To hospital", "At hospital", "Completed"]}
            current={statusIndex}
          />
        </div>
      </Card>
    </div>
  );
}
