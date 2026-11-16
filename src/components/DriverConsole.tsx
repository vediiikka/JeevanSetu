"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import MapView from "@/components/MapView";
import { Alert, Badge, Card, EmptyState, KeyValue, SectionTitle, Spinner } from "@/components/ui";
import { api, onSessionExpired, setSessionToken } from "@/lib/useLive";
import { formatDistance, formatDuration, formatEta, haversine } from "@/lib/geo";
import { useVehiclePose } from "@/lib/movingPoint";
import { RouteOptionCards } from "@/components/RouteOptionCards";
import { TrafficLegend } from "@/components/TrafficLegend";
import { networkToLines, type MapTrafficLine, type TrafficSegmentView } from "@/lib/trafficView";
import { routeLabelMarkers, routeLines } from "@/lib/routeStyle";
import {
  categoryIcon,
  categoryLabel,
  disruptionIcon,
  disruptionLabel,
  statusLabel,
  STATUS_TONE,
} from "@/lib/domain";

type SessionUser = { id: number; name: string; email: string; role: string; phone: string };
type DriverRow = { id: number; name: string; phone: string; status: string; ambulanceId: number | null; licenseNo: string };

type RouteStepView = { name: string; instruction: string; distanceMeters: number; startMeters: number; durationSeconds: number };
type PlanOption = {
  label: string;
  trafficMix?: { green: number; orange: number; red: number };
  key?: string;
  algorithm?: string;
  overlapWithFastest?: number;
  nodesExpanded?: number;
  computeMs?: number;
  distinct?: boolean;
  segments?: TrafficSegmentView[];
  engine?: string;
  steps?: RouteStepView[];
  geometry: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  delaySeconds: number;
  traffic: string;
  roadNames: string[];
  disruptions: { id: number; title: string; type: string; severity: string; roadName: string; confidence?: number; verification?: string }[];
};
type Plan = { options: PlanOption[]; fastest: PlanOption | null; generatedAt: string; provider?: string };

type DriverContext = {
  driver: DriverRow;
  ambulance: { id: number; code: string; type: string; status: string; lat: number; lng: number } | null;
  request: {
    id: number;
    publicId: string;
    status: string;
    category: string;
    severity: string;
    patientName: string;
    patientPhone: string;
    pickupLat: number;
    pickupLng: number;
    pickupAddress: string;
    etaMinutes: number | null;
    distanceKm: number | null;
    notes: string;
  } | null;
  hospital: { id: number; name: string; address: string; lat: number; lng: number; phone: string } | null;
  trip: { id: number; status: string; acceptedAt: string | null; arrivedPickupAt: string | null; pickedUpAt: string | null } | null;
  route: {
    id: number;
    mode?: string;
    geometry: [number, number][];
    distanceMeters: number;
    durationSeconds: number;
    createdAt: string;
    trafficSummary?: {
      key?: string;
      label?: string;
      algorithm?: string;
      segments?: TrafficSegmentView[];
      steps?: RouteStepView[];
    };
  } | null;
  disruptions: {
    id: number;
    title: string;
    type: string;
    severity: string;
    lat: number;
    lng: number;
    status: string;
    confidence?: number;
    verification?: string;
    sourceName?: string | null;
  }[];
  ambulanceProgress?: number;
  routeDurationSeconds?: number | null;
  ambulanceUpdatedAt?: string | null;
  reroute: {
    id: number;
    reason: string;
    action: string;
    oldEtaMinutes: number | null;
    newEtaMinutes: number | null;
    createdAt: string;
  } | null;
};

const GEOFENCE_METERS = 150;

export default function DriverConsole() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [driver, setDriver] = useState<DriverRow | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [credentials, setCredentials] = useState({ email: "rakesh.patel@jeevansetu.in", password: "driver123" });
  const [authError, setAuthError] = useState<string | null>(null);
  const [roleNotice, setRoleNotice] = useState<string | null>(null);
  useEffect(() => onSessionExpired(() => {
    setUser(null);
    setDriver(null);
    setContext(null);
    setPlan(null);
    setRoleNotice("Your session has ended. Please sign in again.");
  }), []);

  const [context, setContext] = useState<DriverContext | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [gpsNote, setGpsNote] = useState<string | null>(null);
  const [autoPickup, setAutoPickup] = useState(true);
  const [follow, setFollow] = useState(true);
  const [trafficOn, setTrafficOn] = useState(true);
  const [netTraffic, setNetTraffic] = useState<MapTrafficLine[]>([]);
  const [choosing, setChoosing] = useState<string | null>(null);
  // Hooks must run unconditionally, before the session/nav early returns.
  const vehiclePose = useVehiclePose(
    context?.route?.geometry ?? null,
    context?.ambulanceProgress ?? 0,
    context?.routeDurationSeconds ?? null,
    context?.ambulanceUpdatedAt ?? null,
  );
  const ambulanceGeometry = context?.route?.geometry ?? null;
  const autoConfirmRef = useRef(false);

  useEffect(() => {
    void api<{ user: SessionUser | null; driver: DriverRow | null }>("/api/auth/me")
      .then((data) => {
        setUser(data.user);
        setDriver(data.driver);
        if (data.user && !data.driver) setRoleNotice(`Signed in as ${data.user.name} (${data.user.role}). The driver console needs a driver account. Sign in below with a driver account.`);
      })
      .catch(() => setRoleNotice("Could not check your session. Check the connection and sign in again."))
      .finally(() => setAuthLoading(false));
  }, []);

  const loadContext = useCallback(async () => {
    try {
      const data = await api<{ context: DriverContext | null }>("/api/driver/context");
      setContext(data.context);
      if (data.context?.request) {
        const route = await api<{ plan: Plan }>(`/api/requests/${data.context.request.id}/route`);
        setPlan(route.plan);
      } else {
        setPlan(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load driver context");
    }
  }, []);

  // Traffic heatmap around the ambulance, refreshed every 30 seconds.
  const trafficCenter = context?.ambulance ? `${context.ambulance.lat.toFixed(4)},${context.ambulance.lng.toFixed(4)}` : null;
  useEffect(() => {
    if (!trafficCenter || !trafficOn) return;
    const [lat, lng] = trafficCenter.split(",");
    let cancelled = false;
    const load = () =>
      api<{ edges: { level: "green" | "orange" | "red"; points: [number, number][] }[] }>(
        `/api/traffic?lat=${lat}&lng=${lng}&radius=2500`,
      )
        .then((data) => {
          if (!cancelled) setNetTraffic(networkToLines(data.edges, "net", 3, 0.5));
        })
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [trafficCenter, trafficOn]);

  useEffect(() => {
    if (!user || !driver) return;
    void loadContext();
    const timer = setInterval(() => void loadContext(), 5000);
    return () => clearInterval(timer);
  }, [user, driver, loadContext]);

  // Browser GPS watch for geofence arrival detection.
  useEffect(() => {
    if (!user || !driver) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGpsError("Geolocation unavailable — use manual pickup confirmation.");
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const next = { lat: position.coords.latitude, lng: position.coords.longitude };
        setGps(next);
        setGpsError(null);
        void api<{ accepted: boolean; reason: string }>("/api/driver/position", { method: "POST", body: JSON.stringify(next) })
          .then((result) => setGpsNote(result.accepted ? null : result.reason))
          .catch(() => undefined);
      },
      () => setGpsError("Location permission denied — manual confirmation remains available."),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [user, driver]);

  const request = context?.request ?? null;
  const distanceToPickup = useMemo(() => {
    if (!gps || !request) return null;
    return haversine(gps, { lat: request.pickupLat, lng: request.pickupLng });
  }, [gps, request]);

  const confirmPickup = useCallback(
    async (method: "geofence" | "manual") => {
      if (!request) return;
      setBusy("pickup");
      setError(null);
      try {
        await api(`/api/requests/${request.id}/pickup`, {
          method: "POST",
          body: JSON.stringify({ method }),
        });
        setNotice(
          method === "geofence"
            ? "Geofence arrival detected — pickup confirmed, navigating to hospital."
            : "Pickup confirmed manually — navigating to hospital.",
        );
        await loadContext();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not confirm pickup");
      } finally {
        setBusy(null);
      }
    },
    [request, loadContext],
  );

  // Automatic geofence confirmation.
  useEffect(() => {
    if (!autoPickup || !request || request.status !== "enroute_pickup") return;
    if (distanceToPickup === null || distanceToPickup > GEOFENCE_METERS) return;
    if (autoConfirmRef.current) return;
    autoConfirmRef.current = true;
    void confirmPickup("geofence");
  }, [autoPickup, request, distanceToPickup, confirmPickup]);

  useEffect(() => {
    if (request?.status !== "enroute_pickup") autoConfirmRef.current = false;
  }, [request?.status]);

  const login = async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const data = await api<{ user: SessionUser; token: string }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(credentials),
      });
      setSessionToken(data.token);
      setRoleNotice(null);
      setUser(data.user);
      const me = await api<{ driver: DriverRow | null }>("/api/auth/me");
      setDriver(me.driver);
      if (me.driver) await loadContext();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setAuthLoading(false);
    }
  };

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setSessionToken(null);
    setUser(null);
    setDriver(null);
    setContext(null);
    setPlan(null);
  };

  const chooseRoute = async (key: string) => {
    if (!request) return;
    setChoosing(key);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ option: { label: string }; etaMinutes: number }>(
        `/api/requests/${request.id}/route-option`,
        { method: "POST", body: JSON.stringify({ option: key }) },
      );
      setNotice(`${result.option.label} route selected: ETA ${result.etaMinutes} min. The ambulance will drive this road route.`);
      await loadContext();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The route could not be selected");
    } finally {
      setChoosing(null);
    }
  };

  const act = async (key: string, url: string, body?: unknown) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await api(url, { method: "POST", body: body ? JSON.stringify(body) : undefined });
      await loadContext();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const toggleAvailability = async () => {
    if (!driver) return;
    setBusy("status");
    try {
      const nextStatus = driver.status === "offline" ? "online" : "offline";
      const data = await api<{ driver: DriverRow }>("/api/drivers", {
        method: "PATCH",
        body: JSON.stringify({ id: driver.id, status: nextStatus }),
      });
      setDriver(data.driver);
      setNotice(nextStatus === "online" ? "You are online and can receive emergencies." : "You are offline.");
      await loadContext();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update availability");
    } finally {
      setBusy(null);
    }
  };

  const ambulancePosition = vehiclePose?.position ??
    (context?.ambulance ? { lat: context.ambulance.lat, lng: context.ambulance.lng } : null);
  const ambulanceRemaining = vehiclePose
    ? { meters: vehiclePose.remainingMeters, seconds: vehiclePose.remainingSeconds }
    : null;

  const markers = useMemo(() => {
    const list: {
      id: string;
      lat: number;
      lng: number;
      kind: "ambulance" | "patient" | "hospital" | "disruption" | "driver";
      label?: string;
      detail?: string;
    }[] = [];
    if (request) {
      list.push({
        id: "pickup",
        lat: request.pickupLat,
        lng: request.pickupLng,
        kind: "patient",
        label: "Patient",
        detail: `${request.patientName} · ${request.patientPhone}`,
      });
    }
    if (context?.hospital) {
      list.push({
        id: "hospital",
        lat: context.hospital.lat,
        lng: context.hospital.lng,
        kind: "hospital",
        label: context.hospital.name,
        detail: context.hospital.address,
      });
    }
    for (const disruption of context?.disruptions ?? []) {
      list.push({
        id: `disruption-${disruption.id}`,
        lat: disruption.lat,
        lng: disruption.lng,
        kind: "disruption",
        label: disruptionLabel(disruption.type),
        detail: `${disruption.title} (${disruption.severity})`,
      });
    }
    return list;
  }, [context, request]);

  // The selected route is drawn as a traffic heatmap; the other two options as dashed lines.
  const selectedKey = context?.route
    ? context.route.trafficSummary?.key ??
      (context.route.mode?.startsWith("option:") ? context.route.mode.slice("option:".length) : "fastest")
    : null;
  const polylines = useMemo(
    () => routeLines(plan?.options ?? [], selectedKey, context?.route?.geometry ?? null),
    [plan, context?.route?.geometry, selectedKey],
  );

  const routeLabels = useMemo(() => routeLabelMarkers(plan?.options ?? [], selectedKey), [plan, selectedKey]);

  const trafficLines = useMemo<MapTrafficLine[]>(() => (trafficOn ? netTraffic : []), [trafficOn, netTraffic]);

  // Turn-by-turn: the next manoeuvre along the selected route, from the driven progress.
  const nextManeuver = (() => {
    const steps =
      context?.route?.trafficSummary?.steps ?? plan?.options.find((o) => o.key === selectedKey)?.steps ?? plan?.fastest?.steps ?? [];
    const total = context?.route?.distanceMeters ?? plan?.fastest?.distanceMeters ?? 0;
    if (steps.length === 0 || total <= 0) return null;
    const travelled = Math.max(0, Math.min(1, context?.ambulanceProgress ?? 0)) * total;
    const upcoming = steps.find((step) => step.startMeters > travelled + 5) ?? null;
    if (!upcoming) return { instruction: "Arriving at destination", metersAway: 0, road: steps[steps.length - 1]?.name ?? "" };
    return {
      instruction: upcoming.instruction,
      metersAway: Math.max(0, upcoming.startMeters - travelled),
      road: upcoming.name,
    };
  })();

  const circles = useMemo(
    () =>
      (context?.disruptions ?? []).map((disruption) => ({
        id: `circle-${disruption.id}`,
        lat: disruption.lat,
        lng: disruption.lng,
        radius: disruption.severity === "severe" ? 700 : 450,
        color: disruption.severity === "severe" ? "#ef4444" : "#f59e0b",
        label: `${disruptionIcon(disruption.type)} ${disruption.title}`,
      })),
    [context],
  );

  if (authLoading) {
    return (
      <Card className="card-pad">
        <Spinner label="Checking session…" />
      </Card>
    );
  }

  if (!user || !driver) {
    return (
      <div className="auth-shell auth-layout mx-auto">
        <section className="auth-story auth-story-driver">
          <div className="auth-story-brand">
            <Image src="/brand/jeevansetu-mark.png" alt="" width={54} height={50} />
            <span>JeevanSetu <span>· Field response</span></span>
          </div>
          <p className="auth-kicker">AMBULANCE CREW WORKSPACE</p>
          <h1>Every call. One clear next step.</h1>
          <p className="auth-story-copy">
            Get the assignment, follow a road-aware route and keep dispatch informed as the situation changes.
          </p>
          <div className="driver-steps">
            <div><span>1</span><p>Receive the call <small>See pickup details and urgency.</small></p></div>
            <div><span>2</span><p>Navigate with confidence <small>Live location and rerouting stay in sync.</small></p></div>
            <div><span>3</span><p>Complete the hand-off <small>Confirm arrival at the hospital.</small></p></div>
          </div>
          <div className="auth-story-foot"><span className="status-dot" /> Your location is shared while on duty</div>
        </section>
        <Card className="card-pad auth-panel">
          <div className="auth-brand">
            <Image src="/brand/jeevansetu-mark.png" alt="" width={48} height={46} className="auth-mark" />
            <div>
              <p className="auth-kicker">JeevanSetu secure access</p>
              <p className="auth-caption">Ambulance crew workspace</p>
            </div>
          </div>
          <h2 className="text-lg font-bold text-white">Driver sign-in</h2>
          <p className="mt-1 text-xs text-slate-400">
            Sign in to receive and manage assigned emergency pickups.
          </p>
          {roleNotice ? <div className="mt-3"><Alert tone="amber">{roleNotice}</Alert></div> : null}
          <div className="mt-4 space-y-3">
            <div>
              <label className="label" htmlFor="email">
                Username or email
              </label>
              <input
                id="email"
                className="input"
                value={credentials.email}
                placeholder="rakesh.patel or rakesh.patel@jeevansetu.in"
                onChange={(event) => setCredentials((prev) => ({ ...prev, email: event.target.value }))}
              />
            </div>
            <div>
              <label className="label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                className="input"
                value={credentials.password}
                onChange={(event) => setCredentials((prev) => ({ ...prev, password: event.target.value }))}
              />
            </div>
            {authError ? <Alert tone="red">{authError}</Alert> : null}
            <button type="button" className="btn btn-primary w-full" onClick={login}>
              Sign in to driver console
            </button>
            <p className="text-[11px] text-slate-500">
              Demo: rakesh.patel@jeevansetu.in / driver123 (every driver logs in with their own name, e.g. suresh.chauhan@jeevansetu.in). Admin: admin@jeevansetu.in / admin123
            </p>
          </div>
        </Card>
      </div>
    );
  }

  const fastest = plan?.fastest ?? null;
  const status = request?.status ?? null;
  const showPickupActions = status === "assigned";
  const showNavigatePickup = status === "enroute_pickup" || status === "accepted";
  const showHospitalLeg = status === "enroute_hospital";
  const showArrival = status === "arrived_hospital";

  return (
    <div className="driver-layout grid gap-5">
      <div className="space-y-4">
        <Card className="card-pad">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="text-base font-bold text-white">Driver console</h1>
              <p className="text-xs text-slate-400">
                {driver.name} · {context?.ambulance ? `${context.ambulance.code} (${context.ambulance.type})` : "No ambulance linked"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={driver.status === "offline" ? "slate" : driver.status === "on_trip" ? "amber" : "green"}>
                {driver.status.replace("_", " ")}
              </Badge>
              <button
                type="button"
                className={`btn btn-sm ${driver.status === "offline" ? "btn-success" : ""}`}
                onClick={toggleAvailability}
                disabled={busy === "status" || Boolean(request)}
              >
                {driver.status === "offline" ? "Go online" : "Go offline"}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={logout}>
                Sign out
              </button>
            </div>
          </div>
          {request ? (
            <p className="mt-2 text-[11px] text-amber-300">
              Availability is locked while an emergency is active. Complete the trip to return to the pool.
            </p>
          ) : null}
        </Card>

        {error ? <Alert tone="red">{error}</Alert> : null}
        {notice ? <Alert tone="green">{notice}</Alert> : null}
        {context?.reroute && context.reroute.action === "recalculated" ? (
          <Alert tone="blue">
            🔄 <strong>Route recalculated automatically.</strong> {context.reroute.reason}. ETA{" "}
            {context.reroute.oldEtaMinutes ?? "—"} → <strong>{context.reroute.newEtaMinutes ?? "—"} min</strong>. New
            guidance is already loaded on the map.
          </Alert>
        ) : null}

        {!request ? (
          <Card className="card-pad">
            <EmptyState
              title="No active emergency assigned"
              hint="Stay online. New emergencies are pushed to this console automatically."
            />
          </Card>
        ) : (
          <Card className="card-pad">
            <SectionTitle
              title={`Emergency ${request.publicId}`}
              subtitle={`${categoryIcon(request.category)} ${categoryLabel(request.category)} · ${request.severity.toUpperCase()}`}
              right={<Badge tone={STATUS_TONE[request.status] ?? "slate"}>{statusLabel(request.status)}</Badge>}
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3">
                <p className="text-[10px] uppercase tracking-wider text-red-300">Pickup</p>
                <p className="text-sm font-semibold text-white">{request.patientName}</p>
                <p className="text-[11px] text-slate-300">{request.pickupAddress || "GPS location"}</p>
                <p className="text-[11px] text-slate-400">{request.patientPhone}</p>
                {distanceToPickup !== null ? (
                  <p className="mt-1 text-[11px] text-emerald-300">
                    You are {formatDistance(distanceToPickup)} from the patient
                    {distanceToPickup <= GEOFENCE_METERS ? " · inside geofence" : ""}
                  </p>
                ) : null}
              </div>
              <div className="rounded-lg border border-sky-500/40 bg-sky-500/10 p-3">
                <p className="text-[10px] uppercase tracking-wider text-sky-300">Hospital destination</p>
                <p className="text-sm font-semibold text-white">{context?.hospital?.name ?? "—"}</p>
                <p className="text-[11px] text-slate-300">{context?.hospital?.address}</p>
                <p className="text-[11px] text-slate-400">{context?.hospital?.phone}</p>
              </div>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-2.5">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">ETA</p>
                <p className="text-lg font-bold text-white">{formatEta(request.etaMinutes)}</p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-2.5">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Distance</p>
                <p className="text-lg font-bold text-white">
                  {request.distanceKm ? `${request.distanceKm} km` : fastest ? formatDistance(fastest.distanceMeters) : "—"}
                </p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-2.5">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Traffic</p>
                <p className="text-lg font-bold capitalize text-white">{fastest?.traffic ?? "—"}</p>
              </div>
              <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2.5 sm:col-span-3">
                <p className="text-[10px] uppercase tracking-wider text-emerald-300">Live position on route</p>
                <p className="text-sm font-semibold text-white">
                  {ambulanceRemaining
                    ? `${formatDistance(ambulanceRemaining.meters)} remaining · ${formatDuration(ambulanceRemaining.seconds)}`
                    : "waiting for route"}
                  {fastest?.roadNames[0] ? ` · next: ${fastest.roadNames[0]}` : ""}
                  {vehiclePose ? ` · ${Math.round(vehiclePose.speedKph)} km/h` : ""}
                </p>
              </div>
            </div>

            {fastest ? (
              <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/50 p-2.5 text-[11px] text-slate-400">
                <p className="font-semibold text-slate-200">{fastest.label}</p>
                <p>
                  {formatDuration(fastest.durationSeconds)} · {formatDistance(fastest.distanceMeters)} ·{" "}
                  {fastest.delaySeconds > 0 ? `+${formatDuration(fastest.delaySeconds)} traffic delay` : "free flowing"}
                </p>
                <p className="mt-1">Via {fastest.roadNames.slice(0, 5).join(" · ")}</p>
                {plan && plan.options.length > 1 ? (
                  <p className="mt-1 text-sky-300">
                    {plan.options.length - 1} alternative route(s) available — recalculated when disruptions change.
                  </p>
                ) : null}
              </div>
            ) : null}

            {fastest && fastest.disruptions.length > 0 ? (
              <div className="mt-2 space-y-1">
                {fastest.disruptions.map((disruption) => (
                  <Alert key={disruption.id} tone="amber">
                    {disruptionIcon(disruption.type)} {disruption.title} · {disruption.severity} severity
                    {disruption.roadName ? ` · ${disruption.roadName}` : ""} · confidence{" "}
                    {Math.round((disruption.confidence ?? 1) * 100)}% · {disruption.verification ?? "verified"}
                  </Alert>
                ))}
              </div>
            ) : null}

            {request?.status === "enroute_hospital" ? (
              <div className="mt-3">
                <Alert tone="green">
                  🚑 <strong>Patient on board.</strong> Driving to {context?.hospital?.name ?? "the hospital"} on the road route. Arrival is recorded automatically when the ambulance reaches the hospital.
                </Alert>
              </div>
            ) : null}
            {plan && plan.options.length > 0 ? (
              <div className="mt-3">
                <p className="label">Route options: choose the road the ambulance drives</p>
                <RouteOptionCards
                  provider={plan?.provider}
                  options={plan.options}
                  selectedKey={selectedKey}
                  onSelect={request.status === "assigned" ? undefined : chooseRoute}
                  busyKey={choosing}
                />
                {request.status === "assigned" ? (
                  <p className="mt-1 text-[10px] text-slate-500">Accept the pickup to choose a route.</p>
                ) : null}
              </div>
            ) : null}
            {request.notes ? (
              <p className="mt-2 rounded-lg border border-slate-800 bg-slate-950/50 p-2 text-[11px] text-slate-300">
                Note: {request.notes}
              </p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              {showPickupActions ? (
                <>
                  <button
                    type="button"
                    className="btn btn-success flex-1"
                    onClick={() => act("accept", `/api/requests/${request.id}/respond`, { action: "accept" })}
                    disabled={busy === "accept"}
                  >
                    {busy === "accept" ? "Accepting…" : "Accept pickup"}
                  </button>
                  <button
                    type="button"
                    className="btn flex-1"
                    onClick={() => act("reject", `/api/requests/${request.id}/respond`, { action: "reject", reason: "Driver unavailable" })}
                    disabled={busy === "reject"}
                  >
                    Reject
                  </button>
                </>
              ) : null}

              {showNavigatePickup ? (
                <>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => act("simulate", "/api/driver/simulate", { meters: 900 })}
                    disabled={busy === "simulate"}
                  >
                    🚑 Advance 900 m (demo)
                  </button>
                  <button
                    type="button"
                    className="btn btn-success flex-1"
                    onClick={() => confirmPickup("manual")}
                    disabled={busy === "pickup"}
                  >
                    {busy === "pickup" ? "Confirming…" : "Confirm pickup (manual fallback)"}
                  </button>
                  <label className="flex items-center gap-2 rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-300">
                    <input type="checkbox" checked={autoPickup} onChange={(event) => setAutoPickup(event.target.checked)} />
                    Auto-confirm inside {GEOFENCE_METERS} m
                  </label>
                </>
              ) : null}

              {showHospitalLeg ? (
                <>
                  <button
                    type="button"
                    className="btn flex-1"
                    onClick={() => act("simulate", "/api/driver/simulate", { meters: 900 })}
                    disabled={busy === "simulate"}
                  >
                    🚑 Advance 900 m (demo)
                  </button>
                  <button
                    type="button"
                    className="btn btn-success flex-1"
                    onClick={() => act("arrive", `/api/requests/${request.id}/hospital-arrival`)}
                    disabled={busy === "arrive"}
                  >
                    Mark hospital arrival
                  </button>
                </>
              ) : null}

              {showArrival ? (
                <button
                  type="button"
                  className="btn btn-success flex-1"
                  onClick={() => act("complete", `/api/requests/${request.id}/complete`)}
                  disabled={busy === "complete"}
                >
                  Complete trip & release ambulance
                </button>
              ) : null}

              <button
                type="button"
                className="btn"
                onClick={() => act("recalc", `/api/requests/${request.id}/route`, {})}
                disabled={busy === "recalc"}
              >
                {busy === "recalc" ? "Recalculating…" : "Recalculate route"}
              </button>
            </div>

            <div className="mt-3">
              <KeyValue label="Trip status" value={statusLabel(context?.trip?.status ?? "—")} />
              <KeyValue
                label="Accepted at"
                value={context?.trip?.acceptedAt ? new Date(context.trip.acceptedAt).toLocaleTimeString() : "—"}
              />
              <KeyValue
                label="Picked up at"
                value={context?.trip?.pickedUpAt ? new Date(context.trip.pickedUpAt).toLocaleTimeString() : "—"}
              />
              <KeyValue label="Route generated" value={plan ? new Date(plan.generatedAt).toLocaleTimeString() : "—"} />
            </div>
          </Card>
        )}

        <Card className="card-pad">
          <SectionTitle title="Active disruptions" subtitle="Live road conditions in the coverage area" />
          {context && context.disruptions.length > 0 ? (
            <ul className="space-y-1.5">
              {context.disruptions.slice(0, 8).map((disruption) => (
                <li key={disruption.id} className="rounded-lg border border-slate-800 bg-slate-950/50 px-2.5 py-1.5">
                  <p className="text-[11px] font-semibold text-slate-200">
                    {disruptionIcon(disruption.type)} {disruption.title}
                  </p>
                  <p className="text-[10px] text-slate-500">
                    {disruptionLabel(disruption.type)} · {disruption.severity} severity · confidence{" "}
                    {Math.round((disruption.confidence ?? 1) * 100)}% · {disruption.verification ?? "verified"}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No active disruptions" hint="Road network is clear." />
          )}
        </Card>
      </div>

      <div className="driver-map-column">
        <Card className="card-pad">
          <SectionTitle
            title="Navigation"
            subtitle="Road-following route to the current objective"
            right={
              <div className="flex items-center gap-2">
                {gps ? <Badge tone="green">GPS live</Badge> : <Badge tone="amber">GPS pending</Badge>}
                <button type="button" className="btn btn-sm" onClick={() => setFollow((value) => !value)}>
                  {follow ? "Following" : "Follow"}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setTrafficOn((value) => !value)}>
                  Traffic {trafficOn ? "on" : "off"}
                </button>
              </div>
            }
          />
          {nextManeuver ? (
            <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-sky-300">Next manoeuvre</p>
                <p className="text-sm font-semibold text-white">{nextManeuver.instruction}</p>
                {nextManeuver.road ? <p className="text-[11px] text-slate-400">{nextManeuver.road}</p> : null}
              </div>
              <div className="text-right">
                <p className="text-lg font-bold tabular-nums text-sky-200">
                  {nextManeuver.metersAway >= 1000
                    ? `${(nextManeuver.metersAway / 1000).toFixed(1)} km`
                    : `${Math.round(nextManeuver.metersAway)} m`}
                </p>
              </div>
            </div>
          ) : null}
          <MapView
            vehicle={
              context?.ambulance && ambulanceGeometry
                ? {
                    geometry: ambulanceGeometry,
                    progress: context.ambulanceProgress ?? 0,
                    durationSeconds: context.routeDurationSeconds ?? null,
                    updatedAt: context.ambulanceUpdatedAt ?? null,
                    label: context.ambulance.code,
                    detail: `${context.ambulance.type} · ${Math.round(vehiclePose?.speedKph ?? 0)} km/h · ${Math.round(
                      vehiclePose?.progress ? vehiclePose.progress * 100 : 0,
                    )}% of route`,
                  }
                : null
            }
            followVehicle={follow}
            center={
              ambulancePosition
                ? [ambulancePosition.lat, ambulancePosition.lng]
                : gps
                  ? [gps.lat, gps.lng]
                  : [23.0225, 72.5714]
            }
            zoom={14}
            markers={[...markers, ...routeLabels]}
            polylines={polylines}
            trafficLines={trafficLines}
            circles={circles}
            fitKey={polylines.length > 0 ? "route" : undefined}
            className="driver-live-map"
          />
          <div className="mt-2">
            <TrafficLegend compact />
          </div>
          {gpsError ? (
            <div className="mt-2">
              <Alert tone="amber">{gpsError}</Alert>
            </div>
          ) : null}
          {gpsNote ? (
            <div className="mt-2">
              <Alert tone="blue">{gpsNote}</Alert>
            </div>
          ) : null}
          <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
            GPS position is streamed to the server for dispatch monitoring. The “Advance 900 m” control is a demo
            helper that moves the unit along the computed route so the workflow can be exercised without a vehicle.
          </p>
        </Card>
      </div>
    </div>
  );
}
