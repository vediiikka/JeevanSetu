"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import MapView from "@/components/MapView";
import { Alert, Badge, Card, EmptyState, KeyValue, ProgressSteps, SectionTitle, Spinner } from "@/components/ui";
import { api } from "@/lib/useLive";
import { formatDistance, formatDuration, formatEta } from "@/lib/geo";
import { TrafficLegend } from "@/components/TrafficLegend";
import { networkToLines, type MapTrafficLine, type TrafficSegmentView } from "@/lib/trafficView";
import { routeLabelMarkers, routeLines } from "@/lib/routeStyle";
import { RouteOptionCards } from "@/components/RouteOptionCards";
import { useVehiclePose } from "@/lib/movingPoint";
import {
  EMERGENCY_CATEGORIES,
  SEVERITIES,
  categoryIcon,
  categoryLabel,
  disruptionIcon,
  disruptionLabel,
  statusLabel,
  STATUS_TONE,
} from "@/lib/domain";

type HospitalJson = {
  id: number;
  code: string;
  name: string;
  address: string;
  city: string;
  phone: string;
  lat: number;
  lng: number;
  emergencyLevel: string;
  traumaLevel: string;
  facilities: string[];
  verified: boolean;
  status: string;
};

type CandidateJson = {
  hospitalId: number;
  code: string;
  name: string;
  address: string;
  city: string;
  phone: string;
  emergencyLevel: string;
  traumaLevel: string;
  facilities: string[];
  verified: boolean;
  durationSeconds: number;
  distanceMeters: number;
  suitability: number;
  missing: string[];
  matched: string[];
  traffic: string;
  disruptions: { id: number; title: string; type: string; severity: string; roadName: string }[];
};

type PlanOptionJson = {
  label: string;
  key?: string;
  algorithm?: string;
  trafficMix?: { green: number; orange: number; red: number };
  overlapWithFastest?: number;
  nodesExpanded?: number;
  computeMs?: number;
  geometry: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  freeFlowSeconds: number;
  delaySeconds: number;
  traffic: string;
  roadNames: string[];
  disruptions: { id: number; title: string; type: string; severity: string; roadName: string }[];
};

type PlanJson = {
  provider?: string;
  options: PlanOptionJson[];
  fastest: PlanOptionJson | null;
  generatedAt: string;
  networkSize: { nodes: number; edges: number };
};

type LocationResult = {
  lat: number;
  lng: number;
  name?: string;
  displayName: string;
  shortAddress: string;
};

type DetailJson = {
  request: {
    id: number;
    publicId: string;
    status: string;
    category: string;
    severity: string;
    mode: string;
    patientName: string;
    patientPhone: string;
    pickupLat: number;
    pickupLng: number;
    pickupAddress: string;
    etaMinutes: number | null;
    distanceKm: number | null;
    createdAt: string;
    updatedAt: string;
    notes: string;
  };
  hospital: HospitalJson | null;
  preferredHospital: HospitalJson | null;
  ambulance: {
    id: number;
    code: string;
    type: string;
    status: string;
    lat: number;
    lng: number;
    facilities: string[];
  } | null;
  driver: { id: number; name: string; phone: string; licenseNo: string } | null;
  trip: { id: number; status: string; acceptedAt: string | null; arrivedPickupAt: string | null; pickedUpAt: string | null } | null;
  route: { id: number; mode: string; distanceMeters: number; durationSeconds: number; createdAt: string; geometry: [number, number][]; trafficSummary?: { key?: string; segments?: TrafficSegmentView[] } } | null;
  plan: PlanJson | null;
  ambulanceProgress?: number;
  routeDurationSeconds?: number | null;
  ambulanceUpdatedAt?: string | null;
  disruptions: {
    id: number;
    title: string;
    type: string;
    severity: string;
    status: string;
    lat: number;
    lng: number;
    confidence?: number;
    verification?: string;
    sourceName?: string | null;
  }[];
};

const STATUS_FLOW = ["assigned", "enroute_pickup", "arrived_pickup", "enroute_hospital", "arrived_hospital", "completed"];

export default function PatientConsole() {
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [address, setAddress] = useState("");
  const [locationQuery, setLocationQuery] = useState("");
  const [addressToPin, setAddressToPin] = useState("");
  const [locationResults, setLocationResults] = useState<LocationResult[]>([]);
  const [searchingLocations, setSearchingLocations] = useState(false);
  const [locationSearchError, setLocationSearchError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [hospitals, setHospitals] = useState<HospitalJson[]>([]);
  const [candidates, setCandidates] = useState<CandidateJson[]>([]);
  const [ranking, setRanking] = useState(false);
  const [form, setForm] = useState({
    patientName: "",
    patientPhone: "",
    category: "cardiac",
    severity: "serious",
    mode: "nearest" as "nearest" | "desired",
    preferredHospitalId: 0,
    notes: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailJson | null>(null);
  const [activePublicId, setActivePublicId] = useState<string | null>(null);
  const [dispatchNote, setDispatchNote] = useState<string | null>(null);
  const rankSeq = useRef(0);
  const locationSelectionVersion = useRef(0);

  useEffect(() => {
    void api<{ hospitals: HospitalJson[] }>("/api/hospitals")
      .then((data) => setHospitals(data.hospitals))
      .catch(() => setHospitals([]));
  }, []);

  const locate = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoError("Geolocation is not available in this browser. Drop a pin on the map instead.");
      return;
    }
    const selectionVersion = ++locationSelectionVersion.current;
    setLocating(true);
    setGeoError(null);
    setLocationQuery("");
    setAddressToPin("");
    setLocationResults([]);
    setSearchingLocations(false);
    setLocationSearchError(null);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        if (selectionVersion !== locationSelectionVersion.current) return;
        const next = { lat: position.coords.latitude, lng: position.coords.longitude };
        setCoords(next);
        setAddress("");
        setLocating(false);
        try {
          const geo = await api<{ shortAddress: string | null }>(
            `/api/geocode?lat=${next.lat}&lng=${next.lng}`,
          );
          if (selectionVersion !== locationSelectionVersion.current) return;
          setAddress(geo.shortAddress ?? `Dropped pin (${next.lat.toFixed(4)}, ${next.lng.toFixed(4)})`);
        } catch {
          if (selectionVersion === locationSelectionVersion.current) {
            setAddress(`Dropped pin (${next.lat.toFixed(4)}, ${next.lng.toFixed(4)})`);
          }
        }
      },
      () => {
        if (selectionVersion !== locationSelectionVersion.current) return;
        setLocating(false);
        setGeoError("Location permission denied. Tap the map to drop the pickup pin manually.");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, []);

  useEffect(() => {
    const query = locationQuery.trim();
    if (query.length < 3) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearchingLocations(true);
      setLocationSearchError(null);
      void api<{ results: LocationResult[] }>(
        `/api/geocode?q=${encodeURIComponent(query)}`,
        { signal: controller.signal },
      )
        .then((data) => setLocationResults(data.results))
        .catch((err) => {
          if (!controller.signal.aborted) {
            setLocationResults([]);
            setLocationSearchError(err instanceof Error ? err.message : "Could not search for that location.");
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearchingLocations(false);
        });
    }, 650);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [locationQuery]);

  useEffect(() => {
      locate();
  }, [locate]);

  // Rank hospitals by road travel time + suitability whenever pickup/category changes.
  useEffect(() => {
    if (!coords || form.mode !== "nearest") {
      setCandidates([]);
      return;
    }
    const seq = ++rankSeq.current;
    setRanking(true);
    const timer = setTimeout(() => {
      void api<{ candidates: CandidateJson[] }>("/api/hospitals/rank", {
        method: "POST",
        body: JSON.stringify({ lat: coords.lat, lng: coords.lng, category: form.category }),
      })
        .then((data) => {
          if (seq === rankSeq.current) setCandidates(data.candidates);
        })
        .catch(() => {
          if (seq === rankSeq.current) setCandidates([]);
        })
        .finally(() => {
          if (seq === rankSeq.current) setRanking(false);
        });
    }, 450);
    return () => clearTimeout(timer);
  }, [coords, form.category, form.mode]);

  // Poll the request state while a request is active.
  useEffect(() => {
    if (!activePublicId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api<{ detail: DetailJson }>(`/api/requests/${activePublicId}`);
        if (!cancelled) setDetail(data.detail);
      } catch {
        /* keep previous state */
      }
    };
    void load();
    const timer = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activePublicId]);

  const submit = async () => {
    if (!form.patientName.trim() || !form.patientPhone.trim()) {
      setError("Patient name and contact number are required.");
      return;
    }
    if (!/^[0-9]{10}$/.test(form.patientPhone)) {
      setError("Contact number must contain exactly 10 digits.");
      return;
    }
    if (!coords) {
      setError("Pickup location is required — search for an address, use GPS, or drop a pin on the map.");
      return;
    }
    if (form.mode === "desired" && !form.preferredHospitalId) {
      setError("Select the preferred hospital.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const data = await api<{
        request: { publicId: string };
        ambulanceCandidates?: { status: string; code: string; roadDistanceMeters: number | null; roadDurationSeconds: number | null }[];
      }>("/api/requests", {
        method: "POST",
        body: JSON.stringify({
          patientName: form.patientName,
          patientPhone: form.patientPhone,
          category: form.category,
          severity: form.severity,
          mode: form.mode,
          lat: coords.lat,
          lng: coords.lng,
          pickupAddress: address,
          preferredHospitalId: form.mode === "desired" ? form.preferredHospitalId : null,
          notes: form.notes,
        }),
      });
      const chosen = data.ambulanceCandidates?.find((c) => c.status === "selected");
      const rankedCount = data.ambulanceCandidates?.filter((c) => c.roadDurationSeconds !== null).length ?? 0;
      setDispatchNote(
        chosen
          ? `Closest ambulance by road: ${chosen.code} — ${formatDistance(chosen.roadDistanceMeters ?? 0)}, ${formatDuration(chosen.roadDurationSeconds ?? 0)} away. Chosen from ${rankedCount} ambulance(s) with a road route.`
          : null,
      );
      setActivePublicId(data.request.publicId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit the emergency request");
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setActivePublicId(null);
    setDetail(null);
    setForm((prev) => ({ ...prev, patientName: "", patientPhone: "", notes: "" }));
  };

  const activeGeometry = detail?.plan?.fastest?.geometry ?? detail?.route?.geometry ?? null;
  const vehiclePose = useVehiclePose(
    activeGeometry,
    detail?.ambulanceProgress ?? 0,
    detail?.routeDurationSeconds ?? null,
    detail?.ambulanceUpdatedAt ?? null,
  );

  const mapMarkers = useMemo(() => {
    const markers: {
      id: string;
      lat: number;
      lng: number;
      kind: "ambulance" | "patient" | "hospital" | "disruption" | "pin";
      label?: string;
      detail?: string;
    }[] = [];
    if (coords) {
      markers.push({
        id: "pickup",
        lat: coords.lat,
        lng: coords.lng,
        kind: "patient",
        label: "Patient pickup",
        detail: address || "Dropped pin",
      });
    }
    const hospital = detail?.hospital ?? null;
    if (hospital) {
      markers.push({
        id: "hospital",
        lat: hospital.lat,
        lng: hospital.lng,
        kind: "hospital",
        label: hospital.name,
        detail: `${hospital.emergencyLevel} · ${hospital.address}`,
      });
    }
    for (const disruption of detail?.disruptions ?? []) {
      markers.push({
        id: `disruption-${disruption.id}`,
        lat: disruption.lat,
        lng: disruption.lng,
        kind: "disruption",
        label: disruptionLabel(disruption.type),
        detail: `${disruption.title} (${disruption.severity})`,
      });
    }
    return markers;
  }, [coords, address, detail]);

  // Traffic heatmap of the route the ambulance is driving, plus the surrounding roads.
  const [patientTrafficOn, setPatientTrafficOn] = useState(true);
  const [patientNetTraffic, setPatientNetTraffic] = useState<MapTrafficLine[]>([]);
  const trafficPickupLat = detail?.request.pickupLat;
  const trafficPickupLng = detail?.request.pickupLng;
  useEffect(() => {
    if (!patientTrafficOn || trafficPickupLat === undefined || trafficPickupLng === undefined) return;
    let cancelled = false;
    const load = () =>
      api<{ edges: { level: "green" | "orange" | "red"; points: [number, number][] }[] }>(
        `/api/traffic?lat=${trafficPickupLat}&lng=${trafficPickupLng}&radius=2500`,
      )
        .then((traffic) => {
          if (!cancelled) setPatientNetTraffic(networkToLines(traffic.edges, "pt-net", 3, 0.45));
        })
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [patientTrafficOn, trafficPickupLat, trafficPickupLng]);
  const patientTrafficLines = useMemo<MapTrafficLine[]>(() => {
    if (!patientTrafficOn) return [];
    return patientNetTraffic;
  }, [patientTrafficOn, patientNetTraffic, detail]);

  const patientSelectedKey = detail?.route?.trafficSummary?.key ?? "fastest";
  const mapPolylines = useMemo(
    () => routeLines(detail?.plan?.options ?? [], patientSelectedKey, detail?.route?.geometry ?? null),
    [detail, patientSelectedKey],
  );

  const mapCircles = useMemo(
    () =>
      (detail?.disruptions ?? []).map((disruption) => ({
        id: `circle-${disruption.id}`,
        lat: disruption.lat,
        lng: disruption.lng,
        radius: disruption.severity === "severe" ? 700 : 450,
        color: disruption.severity === "severe" ? "#ef4444" : "#f59e0b",
        label: `${disruptionIcon(disruption.type)} ${disruption.title}`,
      })),
    [detail],
  );

  const statusIndex = detail ? Math.max(0, STATUS_FLOW.indexOf(detail.request.status)) : 0;
  const fastest = detail?.plan?.fastest ?? null;


  return (
    <div
      className={`patient-layout grid gap-5 lg:grid-cols-[minmax(390px,0.72fr)_minmax(0,1.28fr)]${detail ? " has-dispatch" : ""}`}
    >
      <div className="patient-form-column space-y-4">
        <Card className="card-pad patient-request-form">
          <div className="flex items-center justify-between">
            <h1 className="text-base font-bold text-white">Emergency request</h1>
            <Badge tone="red">24×7</Badge>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Share the patient location and emergency type. JeevanSetu assigns the nearest feasible ambulance and keeps
            the route updated.
          </p>
          <p className="mt-2 text-[11px] font-semibold text-sky-300">Patient access · no account or sign-in required</p>

          <div className="mt-4 space-y-3">
            <div>
              <span className="label">1 · Pickup location</span>
              <div className="flex gap-2">
                <button type="button" className="btn flex-1" onClick={locate} disabled={locating}>
                  {locating ? "Detecting…" : "📍 Use my GPS"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    locationSelectionVersion.current += 1;
                    setLocating(false);
                    setCoords({ lat: 23.0225, lng: 72.5714 });
                    setAddress("Ahmedabad city centre (demo pin)");
                    setLocationQuery("");
                    setAddressToPin("");
                    setLocationResults([]);
                    setSearchingLocations(false);
                    setLocationSearchError(null);
                  }}
                >
                  Demo pin
                </button>
              </div>
              <label className="label mt-3 block" htmlFor="pickupLocationSearch">
                Or search an exact address or place
              </label>
              <div className="relative">
                <input
                  id="pickupLocationSearch"
                  className="input w-full"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={locationResults.length > 0}
                  aria-controls="pickupLocationResults"
                  autoComplete="off"
                  value={locationQuery}
                  onChange={(event) => {
                    locationSelectionVersion.current += 1;
                    setLocating(false);
                    setLocationQuery(event.target.value);
                    setCoords(null);
                    setAddress("");
                    setAddressToPin("");
                    setLocationResults([]);
                    setSearchingLocations(event.target.value.trim().length >= 3);
                    setLocationSearchError(null);
                  }}
                  placeholder="Street, landmark, hospital, or area"
                />
                {searchingLocations ? (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">
                    Searching…
                  </span>
                ) : null}
                {locationResults.length > 0 ? (
                  <div
                    id="pickupLocationResults"
                    role="listbox"
                    aria-label="Pickup location suggestions"
                    className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 shadow-xl"
                  >
                    {locationResults.map((result) => (
                      <button
                        key={`${result.lat},${result.lng},${result.displayName}`}
                        type="button"
                        role="option"
                        aria-selected={false}
                        className="block w-full border-b border-slate-800 px-3 py-2.5 text-left last:border-b-0 hover:bg-slate-800"
                        onClick={() => {
                          locationSelectionVersion.current += 1;
                          setCoords({ lat: result.lat, lng: result.lng });
                          setAddress(
                            result.name
                              ? `${result.name}, ${result.shortAddress}`
                              : result.shortAddress || result.displayName,
                          );
                          setAddressToPin("");
                          setLocationQuery("");
                          setLocationResults([]);
                          setSearchingLocations(false);
                          setLocationSearchError(null);
                          setGeoError(null);
                        }}
                      >
                        <span className="block truncate text-xs font-semibold text-slate-200">
                          {result.name || result.shortAddress}
                        </span>
                        <span className="mt-0.5 block line-clamp-2 text-[10px] text-slate-400">
                          {result.name ? result.shortAddress : result.displayName}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {locationSearchError ? (
                <p className="mt-1.5 text-[11px] text-red-300" role="status">{locationSearchError}</p>
              ) : null}
              {!searchingLocations && !locationSearchError && locationQuery.trim().length >= 3 && locationResults.length === 0 ? (
                <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
                  <p className="text-[11px] text-amber-200" role="status">
                    This building may not be listed in map search. You can still use its address by pinning the exact spot on the map.
                  </p>
                  <button
                    type="button"
                    className="btn btn-ghost mt-1.5 !min-h-8 !px-2 !py-1 text-[11px]"
                    onClick={() => {
                      setAddressToPin(locationQuery.trim());
                      setLocationQuery("");
                      setLocationResults([]);
                      setSearchingLocations(false);
                      setLocationSearchError(null);
                      setCoords(null);
                    }}
                  >
                    Use this address and set pin on map
                  </button>
                </div>
              ) : null}
              {addressToPin ? (
                <p className="mt-1.5 text-[11px] font-medium text-amber-700">
                  Now tap the exact building location on the map to set the pickup pin for “{addressToPin}”.
                </p>
              ) : null}
              <p className="mt-1.5 text-[11px] text-slate-500">
                {coords
                  ? `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}${address ? ` · ${address}` : ""}`
                  : "Choose a search result, use GPS, or tap the map to place the pickup pin."}
              </p>
              {geoError ? (
                <div className="mt-2">
                  <Alert tone="amber">{geoError}</Alert>
                </div>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label" htmlFor="patientName">
                  Patient name
                </label>
                <input
                  id="patientName"
                  className="input"
                  required
                  value={form.patientName}
                  onChange={(event) => setForm((prev) => ({ ...prev, patientName: event.target.value }))}
                  placeholder="Full name"
                />
              </div>
              <div>
                <label className="label" htmlFor="patientPhone">
                  Contact number
                </label>
                <input
                  id="patientPhone"
                  className="input"
                  type="tel"
                  inputMode="numeric"
                  pattern="[0-9]{10}"
                  minLength={10}
                  required
                  value={form.patientPhone}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, patientPhone: event.target.value.replace(/[^0-9]/g, "").slice(0, 10) }))
                  }
                  placeholder="10-digit mobile number"
                />
              </div>
            </div>

            <div>
              <span className="label">2 · Emergency category</span>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {EMERGENCY_CATEGORIES.map((category) => (
                  <button
                    key={category.value}
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, category: category.value }))}
                    className={`rounded-lg border px-2 py-1.5 text-left text-[11px] font-semibold transition ${
                      form.category === category.value
                        ? "border-red-500/70 bg-red-500/15 text-red-200"
                        : "border-slate-700 bg-slate-950/50 text-slate-300 hover:border-slate-500"
                    }`}
                  >
                    <span className="mr-1">{category.icon}</span>
                    {category.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="label">Severity</span>
              <div className="flex gap-1.5">
                {SEVERITIES.map((severity) => (
                  <button
                    key={severity}
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, severity }))}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-[11px] font-bold uppercase tracking-wide transition ${
                      form.severity === severity
                        ? severity === "critical"
                          ? "border-red-500 bg-red-600/30 text-red-200"
                          : severity === "serious"
                            ? "border-amber-500 bg-amber-500/20 text-amber-200"
                            : "border-emerald-500 bg-emerald-500/20 text-emerald-200"
                        : "border-slate-700 bg-slate-950/50 text-slate-400"
                    }`}
                  >
                    {severity}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="label">3 · Hospital selection</span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, mode: "nearest" }))}
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-[11px] font-bold uppercase tracking-wide ${
                    form.mode === "nearest"
                      ? "border-sky-500/70 bg-sky-500/15 text-sky-200"
                      : "border-slate-700 bg-slate-950/50 text-slate-400"
                  }`}
                >
                  Nearest suitable
                </button>
                <button
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, mode: "desired" }))}
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-[11px] font-bold uppercase tracking-wide ${
                    form.mode === "desired"
                      ? "border-sky-500/70 bg-sky-500/15 text-sky-200"
                      : "border-slate-700 bg-slate-950/50 text-slate-400"
                  }`}
                >
                  Desired hospital
                </button>
              </div>

              {form.mode === "nearest" ? (
                <div className="mt-2 space-y-1.5">
                  {ranking ? <Spinner label="Ranking hospitals by road travel time…" /> : null}
                  {!ranking && candidates.length === 0 ? (
                    <p className="text-[11px] text-slate-500">Set a pickup location to see ranked hospitals.</p>
                  ) : null}
                  {candidates.map((candidate, index) => (
                    <div
                      key={candidate.hospitalId}
                      className={`rounded-lg border px-2.5 py-2 ${
                        index === 0 ? "border-emerald-500/50 bg-emerald-500/10" : "border-slate-800 bg-slate-950/40"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-xs font-semibold text-slate-100">
                            {index === 0 ? "★ " : ""}
                            {candidate.name}
                          </p>
                          <p className="text-[10px] text-slate-500">
                            {formatDuration(candidate.durationSeconds)} · {formatDistance(candidate.distanceMeters)} ·{" "}
                            {candidate.emergencyLevel}
                          </p>
                        </div>
                        <Badge tone={candidate.suitability >= 80 ? "green" : candidate.suitability >= 55 ? "amber" : "red"}>
                          {candidate.suitability}% fit
                        </Badge>
                      </div>
                      <p className="mt-1 text-[10px] text-slate-500">
                        Matched: {candidate.matched.join(", ") || "emergency care"}
                        {candidate.missing.length > 0 ? ` · Missing: ${candidate.missing.join(", ")}` : ""}
                      </p>
                      {candidate.disruptions.length > 0 ? (
                        <p className="mt-1 text-[10px] text-amber-300">
                          ⚠ {candidate.disruptions.length} disruption(s) on this route
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-2">
                  <select
                    className="input"
                    value={form.preferredHospitalId}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, preferredHospitalId: Number(event.target.value) }))
                    }
                  >
                    <option value={0}>Select a registered hospital…</option>
                    {hospitals
                      .filter((hospital) => hospital.status === "active")
                      .map((hospital) => (
                        <option key={hospital.id} value={hospital.id}>
                          {hospital.name} — {hospital.city} ({hospital.emergencyLevel})
                        </option>
                      ))}
                  </select>
                  <p className="mt-1 text-[10px] text-slate-500">
                    The route to your chosen hospital is still computed on the live road network with disruptions.
                  </p>
                </div>
              )}
            </div>

            <div>
              <label className="label" htmlFor="notes">
                Notes for the crew (optional)
              </label>
              <textarea
                id="notes"
                className="input min-h-[60px]"
                value={form.notes}
                onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
                placeholder="Landmark, gate number, patient condition…"
              />
            </div>

            {error ? <Alert tone="red">{error}</Alert> : null}

            <button type="button" className="btn btn-emergency w-full py-2.5" onClick={submit} disabled={submitting}>
              {submitting ? "Dispatching…" : "🚨 Dispatch ambulance now"}
            </button>
            <p className="text-[10px] leading-relaxed text-slate-500">
              Demonstration system. In a real emergency call 108. Hospital capabilities shown are registered demo
            values, not live bed availability.
          </p>
          </div>
        </Card>

      </div>

      <div className="patient-map-column space-y-4">
        <Card className="card-pad patient-map-card">
          <SectionTitle
            title="Live map"
            subtitle="Actual road-following geometry returned by the routing engine"
            right={
              detail?.ambulance ? (
                <Badge tone="green">Ambulance {detail.ambulance.code}</Badge>
              ) : (
                <Badge tone="slate">Awaiting dispatch</Badge>
              )
            }
          />
          <MapView
            vehicle={
              detail?.ambulance && activeGeometry
                ? {
                    geometry: activeGeometry,
                    progress: detail.ambulanceProgress ?? 0,
                    durationSeconds: detail.routeDurationSeconds ?? null,
                    updatedAt: detail.ambulanceUpdatedAt ?? null,
                    label: detail.ambulance.code,
                    detail: `${detail.ambulance.type} · ${Math.round(vehiclePose?.speedKph ?? 0)} km/h · ${Math.round(
                      (vehiclePose?.progress ?? 0) * 100,
                    )}% of route`,
                  }
                : null
            }
            center={coords ? [coords.lat, coords.lng] : [23.0225, 72.5714]}
            zoom={coords ? 13 : 9}
            markers={[...mapMarkers, ...routeLabelMarkers(detail?.plan?.options ?? [], patientSelectedKey)]}
            polylines={mapPolylines}
            trafficLines={patientTrafficLines}
            circles={mapCircles}
            fitKey={mapPolylines.length > 0 ? "route" : undefined}
            flyTo={coords ? [coords.lat, coords.lng] : null}
            onMapClick={(lat, lng) => {
              locationSelectionVersion.current += 1;
              setLocating(false);
              setCoords({ lat, lng });
              setAddress(
                addressToPin || locationQuery.trim() || `Dropped pin (${lat.toFixed(4)}, ${lng.toFixed(4)})`,
              );
              setAddressToPin("");
              setLocationQuery("");
              setLocationResults([]);
              setSearchingLocations(false);
              setLocationSearchError(null);
            }}
            className="patient-live-map"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <TrafficLegend compact />
            <button type="button" className="btn btn-sm" onClick={() => setPatientTrafficOn((value) => !value)}>
              Traffic {patientTrafficOn ? "on" : "off"}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-slate-500">
            <span className="flex items-center gap-1">
              <span className="h-2 w-4 rounded bg-red-500" /> Active route
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-4 rounded bg-sky-400" /> Alternative
            </span>
            <span className="flex items-center gap-1">🚑 Ambulance</span>
            <span className="flex items-center gap-1">🏥 Hospital</span>
            <span className="flex items-center gap-1">⚠️ Disruption</span>
          </div>
        </Card>

      </div>

      {detail ? (
        <Card className="card-pad patient-dispatch-summary">
          <SectionTitle
            title={`Request ${detail.request.publicId}`}
            subtitle={`Raised ${new Date(detail.request.createdAt).toLocaleTimeString()}`}
            right={<Badge tone={STATUS_TONE[detail.request.status] ?? "slate"}>{statusLabel(detail.request.status)}</Badge>}
          />
          <ProgressSteps
            steps={["Assigned", "To pickup", "Pickup", "To hospital", "At hospital", "Completed"]}
            current={statusIndex}
          />
          {dispatchNote ? <Alert tone="green">{dispatchNote}</Alert> : null}
          <div className="patient-dispatch-details mt-3">
            <KeyValue label="Category" value={`${categoryIcon(detail.request.category)} ${categoryLabel(detail.request.category)}`} />
            <KeyValue label="Severity" value={detail.request.severity.toUpperCase()} />
            <KeyValue label="Mode" value={detail.request.mode === "nearest" ? "Nearest suitable hospital" : "Desired hospital"} />
            <KeyValue label="Destination" value={detail.hospital?.name ?? "—"} />
            <KeyValue
              label="Ambulance"
              value={detail.ambulance ? `${detail.ambulance.code} (${detail.ambulance.type})` : "Finding nearest…"}
            />
            <KeyValue label="Driver" value={detail.driver ? `${detail.driver.name} · ${detail.driver.phone}` : "—"} />
            <KeyValue label="ETA" value={formatEta(detail.request.etaMinutes)} />
            <KeyValue label="Road distance" value={detail.request.distanceKm ? `${detail.request.distanceKm} km` : "—"} />
            <KeyValue
              label="Route updated"
              value={detail.route ? new Date(detail.route.createdAt).toLocaleTimeString() : "—"}
            />
          </div>
          {fastest ? (
            <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/50 p-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-200">{fastest.label}</span>
                <Badge tone={fastest.traffic === "low" ? "green" : fastest.traffic === "moderate" ? "amber" : "red"}>
                  {fastest.traffic} traffic
                </Badge>
              </div>
              <p className="mt-1 text-[11px] text-slate-400">
                {formatDistance(fastest.distanceMeters)} · {formatDuration(fastest.durationSeconds)} ·{" "}
                {fastest.delaySeconds > 0 ? `+${formatDuration(fastest.delaySeconds)} delay` : "free flowing"}
              </p>
              <p className="mt-1 text-[10px] text-slate-500">Via {fastest.roadNames.slice(0, 4).join(" · ")}</p>
              {detail.plan && detail.plan.options.length > 0 ? (
                <div className="mt-2">
                  <RouteOptionCards options={detail.plan.options} selectedKey={patientSelectedKey} provider={detail.plan.provider} />
                </div>
              ) : null}
            </div>
          ) : null}
          {detail.disruptions.length > 0 ? (
            <div className="mt-3">
              <Alert tone="amber">
                {detail.disruptions.length} active disruption(s) in the coverage area. Routes are recalculated
                automatically when they affect your journey. Each event shows its source, confidence and
                verification status — unverified reports never create confirmed closures.
              </Alert>
            </div>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Link href={`/track/${detail.request.publicId}`} className="btn btn-sm flex-1">
              Open live tracking
            </Link>
            <button type="button" className="btn btn-sm" onClick={reset}>
              New request
            </button>
          </div>
        </Card>
      ) : null}
      {detail ? (
        <Card className="card-pad patient-assignment-summary">
          <SectionTitle title="Assigned ambulance" subtitle="Live position and status" />
          {detail.ambulance ? (
            <div className="patient-assignment-details grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                <p className="text-lg font-bold text-white">{detail.ambulance.code}</p>
                <p className="text-xs text-slate-400">
                  {detail.ambulance.type} ambulance · {detail.ambulance.status.replace("_", " ")}
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  {vehiclePose
                    ? `${vehiclePose.position.lat.toFixed(5)}, ${vehiclePose.position.lng.toFixed(5)}`
                    : `${detail.ambulance.lat.toFixed(5)}, ${detail.ambulance.lng.toFixed(5)}`}
                </p>
                <p className="mt-1 text-[11px] font-semibold text-emerald-300">
                  Moving on the fastest route
                  {vehiclePose
                    ? ` · ${Math.round(vehiclePose.speedKph)} km/h · ${formatDistance(vehiclePose.remainingMeters)} to go`
                    : " · live position refreshed every 4s"}
                </p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                <p className="text-xs font-semibold text-slate-200">{detail.driver?.name ?? "Driver not linked"}</p>
                <p className="text-[11px] text-slate-400">{detail.driver?.phone ?? "—"}</p>
                <p className="mt-1 text-[11px] text-slate-500">Licence {detail.driver?.licenseNo || "—"}</p>
              </div>
            </div>
          ) : (
            <EmptyState title="No ambulance assigned yet" hint="The dispatch engine is scanning available units." />
          )}
          <div className="patient-location-details mt-3 grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Pickup</p>
              <p className="text-xs text-slate-200">{detail.request.pickupAddress || "GPS location"}</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Hospital</p>
              <p className="text-xs text-slate-200">{detail.hospital?.name ?? "—"}</p>
              <p className="text-[10px] text-slate-500">{detail.hospital?.address}</p>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
