"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import MapView from "@/components/MapView";
import AdminLiveTracking from "@/components/AdminLiveTracking";
import AdminCreateRequest from "@/components/AdminCreateRequest";
import AddDriverForm from "@/components/AddDriverForm";
import { Alert, Badge, Card, EmptyState, SectionTitle, Spinner, StatCard } from "@/components/ui";
import { api, onSessionExpired, setSessionToken } from "@/lib/useLive";
import { formatDistance, formatDuration } from "@/lib/geo";
import {
  DISRUPTION_SEVERITIES,
  DISRUPTION_TYPES,
  categoryIcon,
  categoryLabel,
  disruptionIcon,
  disruptionLabel,
  statusLabel,
  STATUS_TONE,
} from "@/lib/domain";

type AdminStats = {
  totals: {
    requests: number;
    activeRequests: number;
    ambulances: number;
    available: number;
    busy: number;
    offline: number;
    hospitals: number;
    drivers: number;
    driversOnline: number;
    ongoingTrips: number;
    disruptions: number;
    completedTrips: number;
  };
  recentRequests: {
    id: number;
    publicId: string;
    patientName: string;
    category: string;
    severity: string;
    status: string;
    mode: string;
    etaMinutes: number | null;
    distanceKm: number | null;
    ambulanceId: number | null;
    hospitalId: number | null;
    createdAt: string;
  }[];
  ambulances: { id: number; code: string; type: string; status: string; lat: number; lng: number; driverId: number | null; hospitalId: number | null }[];
  hospitals: { id: number; code: string; name: string; city: string; status: string; verified: boolean; lat: number; lng: number; emergencyLevel: string; facilities: string[] }[];
  drivers: { id: number; name: string; phone: string; status: string; ambulanceId: number | null; licenseNo: string }[];
  trips: { id: number; requestId: number; status: string; ambulanceId: number; distanceKm: number; durationSeconds: number; startedAt: string }[];
  disruptions: {
    id: number;
    title: string;
    type: string;
    severity: string;
    status: string;
    lat: number;
    lng: number;
    description: string;
    reportedBy: string;
    source: string;
    sourceName?: string | null;
    confidence?: number;
    verification?: string;
    needsReview?: boolean;
    eventEndsAt?: string | null;
    lastFetchedAt?: string | null;
    createdAt: string;
  }[];
  routes: { id: number; requestId: number | null; mode: string; distanceMeters: number; durationSeconds: number; createdAt: string }[];
};

type SessionUser = { id: number; name: string; email: string; role: string };

type SourceRow = {
  key: string;
  name: string;
  category: string;
  url: string;
  license: string;
  coverage: string;
  updateFrequency: string;
  authentication: string;
  reliability: string;
  enabled: boolean;
  notes: string;
  runtimeStatus: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastItemCount: number;
};

type RunRow = {
  id: number;
  sourceKey: string;
  sourceName: string;
  status: string;
  itemsFetched: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsFlagged: number;
  message: string;
  error: string | null;
  startedAt: string;
};

type PendingReport = {
  id: number;
  sourceKey: string;
  sourceName: string;
  title: string;
  category: string;
  severity: string;
  confidence: number;
  roadName: string | null;
  rawText: string;
  matchedSegmentIds: number[];
  disruptionId: number | null;
  createdAt: string;
};

type RerouteRow = {
  id: number;
  requestId: number;
  publicId: string | null;
  reason: string;
  action: string;
  oldEtaMinutes: number | null;
  newEtaMinutes: number | null;
  triggerDisruptionId: number | null;
  createdAt: string;
};

type IntelPayload = {
  sources: SourceRow[];
  runs: RunRow[];
  pending: PendingReport[];
  reroutes: RerouteRow[];
  summary: { active: number; verified: number; community: number; unverified: number; needsReview: number; averageConfidence: number } | null;
};

const TABS = [
  "Overview",
  "Live tracking",
  "Create request",
  "Intelligence",
  "Ambulances",
  "Drivers",
  "Hospitals",
  "Disruptions",
  "Route history",
] as const;
type Tab = (typeof TABS)[number];

export default function AdminConsole() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [credentials, setCredentials] = useState({ email: "admin@jeevansetu.in", password: "admin123" });
  const [authError, setAuthError] = useState<string | null>(null);
  const [roleNotice, setRoleNotice] = useState<string | null>(null);
  useEffect(() => onSessionExpired(() => {
    setUser(null);
    setStats(null);
    setRoleNotice("Your session has ended. Please sign in again.");
  }), []);

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  /** Driver chosen from the Drivers tab or the live screen; shared so both stay in step. */
  const [focusDriverId, setFocusDriverId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [intel, setIntel] = useState<IntelPayload | null>(null);
  const [ingestSummary, setIngestSummary] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    title: "",
    type: "construction",
    severity: "moderate",
    description: "",
    lat: 23.0225,
    lng: 72.5714,
  });

  useEffect(() => {
    void api<{ user: SessionUser | null }>("/api/auth/me")
      .then((data) => {
        if (data.user && data.user.role === "admin") setUser(data.user);
        else {
          setUser(null);
          if (data.user) setRoleNotice(`Signed in as ${data.user.name} (${data.user.role}). The admin console needs an admin account. Sign in below with an admin account.`);
        }
      })
      .catch(() => setRoleNotice("Could not check your session. Check the connection and sign in again."))
      .finally(() => setAuthLoading(false));
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api<AdminStats>("/api/admin/stats");
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load admin data");
    }
    try {
      const [sources, runs, disruptions, reroutes] = await Promise.all([
        api<{ sources: SourceRow[] }>("/api/sources"),
        api<{ runs: RunRow[] }>("/api/ingest"),
        api<{ pendingReports: PendingReport[]; summary: IntelPayload["summary"] }>("/api/disruptions"),
        api<{ events: RerouteRow[] }>("/api/reroute/monitor"),
      ]);
      setIntel({
        sources: sources.sources,
        runs: runs.runs,
        pending: disruptions.pendingReports,
        reroutes: reroutes.events,
        summary: disruptions.summary,
      });
    } catch {
      /* intelligence panel is optional for older sessions */
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void load();
    const timer = setInterval(() => void load(), 6000);
    return () => clearInterval(timer);
  }, [user, load]);

  const login = async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const data = await api<{ user: SessionUser; token: string }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(credentials),
      });
      if (data.user.role !== "admin") {
        setAuthError("This account does not have admin access.");
        return;
      }
      setSessionToken(data.token);
      setRoleNotice(null);
      setUser(data.user);
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
    setStats(null);
  };

  const patch = async (url: string, body: unknown, key: string, successMessage: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await api(url, { method: "PATCH", body: JSON.stringify(body) });
      setNotice(successMessage);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(null);
    }
  };

  const createDisruption = async () => {
    if (!draft.title.trim()) {
      setError("Give the disruption a short title.");
      return;
    }
    setBusy("create-disruption");
    setError(null);
    setNotice(null);
    try {
      const data = await api<{ recalculated: number }>("/api/disruptions", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      setNotice(`Disruption reported. ${data.recalculated} active route(s) recalculated.`);
      setDraft((prev) => ({ ...prev, title: "", description: "" }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not report disruption");
    } finally {
      setBusy(null);
    }
  };

  const runIngestion = async () => {
    setBusy("ingest");
    setError(null);
    setNotice(null);
    try {
      const summary = await api<{
        totals: { fetched: number; created: number; updated: number; flagged: number; expired: number };
        reroutes: number;
        sources: { key: string; status: string; message: string }[];
      }>("/api/ingest", { method: "POST", body: JSON.stringify({}) });
      setIngestSummary(
        `Fetched ${summary.totals.fetched} · new ${summary.totals.created} · updated ${summary.totals.updated} · flagged ${summary.totals.flagged} · expired ${summary.totals.expired} · reroute decisions ${summary.reroutes}. ` +
          summary.sources.map((source) => `${source.key}: ${source.status}`).join(" | "),
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ingestion failed");
    } finally {
      setBusy(null);
    }
  };

  const runMonitor = async () => {
    setBusy("monitor");
    setError(null);
    try {
      const result = await api<{ monitored: number; decisions: { action: string; reason: string }[] }>(
        "/api/reroute/monitor",
        { method: "POST", body: JSON.stringify({}) },
      );
      setNotice(
        `Reroute monitor: ${result.monitored} active trip(s) checked, ${result.decisions.length} decision(s): ` +
          (result.decisions.map((decision) => `${decision.action} — ${decision.reason}`).join(" | ") || "no disruption intersects an active route"),
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Monitor failed");
    } finally {
      setBusy(null);
    }
  };

  const verifyReport = async (disruptionId: number, action: "verify" | "reject") => {
    setBusy(`verify-${disruptionId}`);
    setError(null);
    try {
      await api(`/api/disruptions/${disruptionId}/verify`, {
        method: "POST",
        body: JSON.stringify({ action, note: action === "verify" ? "Confirmed by control room" : "Rejected by control room" }),
      });
      setNotice(action === "verify" ? "Report verified — routing now treats it as confirmed." : "Report rejected — it no longer affects routing.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setBusy(null);
    }
  };

  const markers = useMemo(() => {
    if (!stats) return [];
    const list: {
      id: string;
      lat: number;
      lng: number;
      kind: "ambulance" | "hospital" | "disruption";
      label?: string;
      detail?: string;
      tone?: string;
    }[] = [];
    for (const ambulance of stats.ambulances) {
      list.push({
        id: `ambulance-${ambulance.id}`,
        lat: ambulance.lat,
        lng: ambulance.lng,
        kind: "ambulance",
        label: ambulance.code,
        detail: `${ambulance.type} · ${ambulance.status}`,
        tone: ambulance.status === "available" ? "#16a34a" : ambulance.status === "offline" ? "#64748b" : "#dc2626",
      });
    }
    for (const hospital of stats.hospitals) {
      list.push({
        id: `hospital-${hospital.id}`,
        lat: hospital.lat,
        lng: hospital.lng,
        kind: "hospital",
        label: hospital.name.split(" ").slice(0, 2).join(" "),
        detail: `${hospital.city} · ${hospital.emergencyLevel}`,
      });
    }
    for (const disruption of stats.disruptions) {
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
  }, [stats]);

  const circles = useMemo(
    () =>
      (stats?.disruptions ?? []).map((disruption) => ({
        id: `circle-${disruption.id}`,
        lat: disruption.lat,
        lng: disruption.lng,
        radius: disruption.severity === "severe" ? 900 : 550,
        color: disruption.severity === "severe" ? "#ef4444" : disruption.severity === "high" ? "#f97316" : "#f59e0b",
        label: `${disruptionIcon(disruption.type)} ${disruption.title}`,
      })),
    [stats],
  );

  if (authLoading) {
    return (
      <Card className="card-pad">
        <Spinner label="Checking session…" />
      </Card>
    );
  }

  if (!user) {
    return (
      <div className="auth-shell auth-layout mx-auto">
        <section className="auth-story">
          <div className="auth-story-brand">
            <Image src="/brand/jeevansetu-mark.png" alt="" width={54} height={50} />
            <span>JeevanSetu <span>· Operations</span></span>
          </div>
          <p className="auth-kicker">GUJARAT EMERGENCY NETWORK</p>
          <h1>One clear view of every moving part.</h1>
          <p className="auth-story-copy">
            Coordinate ambulance availability, active requests, hospital capacity records and road conditions from one
            calm, connected control room.
          </p>
          <div className="auth-story-points">
            <div><span>01</span><p>Live fleet visibility <small>Track units, routes and driver status.</small></p></div>
            <div><span>02</span><p>Confident dispatch <small>Review requests and hospital matches.</small></p></div>
            <div><span>03</span><p>Road-aware response <small>Manage disruptions and reroutes.</small></p></div>
          </div>
          <div className="auth-story-foot"><span className="status-dot" /> Control room access is monitored</div>
        </section>
        <Card className="card-pad auth-panel">
          <div className="auth-brand">
            <Image src="/brand/jeevansetu-mark.png" alt="" width={48} height={46} className="auth-mark" />
            <div>
              <p className="auth-kicker">JeevanSetu secure access</p>
              <p className="auth-caption">Operations and fleet workspace</p>
            </div>
          </div>
          <h2 className="text-lg font-bold text-white">Admin sign-in</h2>
          <p className="mt-1 text-xs text-slate-400">Control room access for fleet, hospitals and road disruptions.</p>
          {roleNotice ? <div className="mt-3"><Alert tone="amber">{roleNotice}</Alert></div> : null}
          <div className="mt-4 space-y-3">
            <div>
              <label className="label" htmlFor="admin-email">
                Username or email
              </label>
              <input
                id="admin-email"
                className="input"
                value={credentials.email}
                placeholder="admin or admin@jeevansetu.in"
                onChange={(event) => setCredentials((prev) => ({ ...prev, email: event.target.value }))}
              />
            </div>
            <div>
              <label className="label" htmlFor="admin-password">
                Password
              </label>
              <input
                id="admin-password"
                type="password"
                className="input"
                value={credentials.password}
                onChange={(event) => setCredentials((prev) => ({ ...prev, password: event.target.value }))}
              />
            </div>
            {authError ? <Alert tone="red">{authError}</Alert> : null}
            <button type="button" className="btn btn-primary w-full" onClick={login}>
              Sign in to control room
            </button>
            <p className="text-[11px] text-slate-500">Demo: admin@jeevansetu.in / admin123</p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="card-pad">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-base font-bold text-white">Admin control room</h1>
            <p className="text-xs text-slate-400">
              {user.name} · live fleet, hospitals, disruptions and route history for Gujarat
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="green">Live · 6s refresh</Badge>
            <button type="button" className="btn btn-sm btn-ghost" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
      </Card>

      {error ? <Alert tone="red">{error}</Alert> : null}
      {notice ? <Alert tone="green">{notice}</Alert> : null}

      {!stats ? (
        <Card className="card-pad">
          <Spinner label="Loading control room data…" />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            <StatCard label="Total requests" value={stats.totals.requests} hint={`${stats.totals.activeRequests} active`} />
            <StatCard label="Active ambulances" value={stats.totals.ambulances} hint={`${stats.totals.offline} offline`} tone="blue" />
            <StatCard label="Available" value={stats.totals.available} tone="green" />
            <StatCard label="Busy" value={stats.totals.busy} tone="amber" />
            <StatCard label="Hospitals" value={stats.totals.hospitals} hint={`${stats.totals.drivers} drivers`} />
            <StatCard label="Ongoing trips" value={stats.totals.ongoingTrips} tone="red" hint={`${stats.totals.completedTrips} completed`} />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {TABS.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setTab(item)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                  tab === item
                    ? "border-red-500/70 bg-red-500/15 text-red-200"
                    : "border-slate-700 bg-slate-900/60 text-slate-400 hover:border-slate-500"
                }`}
              >
                {item}
                {item === "Disruptions" ? ` (${stats.totals.disruptions})` : ""}
              </button>
            ))}
          </div>

          {tab === "Overview" ? (
            <div className="admin-overview grid gap-5 lg:grid-cols-[minmax(0,1.18fr)_minmax(360px,0.82fr)]">
              <Card className="card-pad">
                <SectionTitle title="Fleet & disruption map" subtitle="All ambulances, hospitals and active disruptions" />
                <MapView
                  center={[23.0225, 72.5714]}
                  zoom={8}
                  markers={[
                    ...markers,
                    { id: "draft-disruption", lat: draft.lat, lng: draft.lng, kind: "disruption", label: "New disruption" },
                  ]}
                  circles={circles}
                  onMapClick={(lat, lng) => setDraft((prev) => ({ ...prev, lat, lng }))}
                  className="admin-live-map"
                />
                <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-slate-500">
                  <span>🚑 Ambulance (green = available, red = busy)</span>
                  <span>🏥 Hospital</span>
                  <span>⚠️ Disruption</span>
                </div>
              </Card>
              <div className="space-y-4">
                <Card className="card-pad">
                  <SectionTitle title="Recent emergency requests" subtitle="Newest first" />
                  <div className="space-y-1.5">
                    {stats.recentRequests.slice(0, 8).map((request) => (
                      <div key={request.id} className="rounded-lg border border-slate-800 bg-slate-950/50 px-2.5 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[11px] font-semibold text-slate-200">
                            {categoryIcon(request.category)} {request.publicId} · {request.patientName}
                          </p>
                          <Badge tone={STATUS_TONE[request.status] ?? "slate"}>{statusLabel(request.status)}</Badge>
                        </div>
                        <p className="text-[10px] text-slate-500">
                          {categoryLabel(request.category)} · {request.severity} ·{" "}
                          {request.etaMinutes ? `${request.etaMinutes} min ETA` : "no ETA"} ·{" "}
                          {new Date(request.createdAt).toLocaleTimeString()}
                        </p>
                      </div>
                    ))}
                    {stats.recentRequests.length === 0 ? <EmptyState title="No requests yet" /> : null}
                  </div>
                </Card>
                <Card className="card-pad">
                  <SectionTitle title="Report a road disruption" subtitle="Click the map to place the location" />
                  <div className="space-y-2">
                    <input
                      className="input"
                      placeholder="Title (e.g. Waterlogging near Paldi)"
                      value={draft.title}
                      onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        className="input"
                        value={draft.type}
                        onChange={(event) => setDraft((prev) => ({ ...prev, type: event.target.value }))}
                      >
                        {DISRUPTION_TYPES.map((type) => (
                          <option key={type.value} value={type.value}>
                            {type.label}
                          </option>
                        ))}
                      </select>
                      <select
                        className="input"
                        value={draft.severity}
                        onChange={(event) => setDraft((prev) => ({ ...prev, severity: event.target.value }))}
                      >
                        {DISRUPTION_SEVERITIES.map((severity) => (
                          <option key={severity} value={severity}>
                            {severity} severity
                          </option>
                        ))}
                      </select>
                    </div>
                    <textarea
                      className="input min-h-[56px]"
                      placeholder="Description / expected delay"
                      value={draft.description}
                      onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
                    />
                    <p className="text-[10px] text-slate-500">
                      Location: {draft.lat.toFixed(4)}, {draft.lng.toFixed(4)} — click the fleet map to choose a location.
                    </p>
                    <button
                      type="button"
                      className="btn btn-primary w-full"
                      onClick={createDisruption}
                      disabled={busy === "create-disruption"}
                    >
                      {busy === "create-disruption" ? "Reporting…" : "Report disruption & re-route"}
                    </button>
                  </div>
                </Card>
              </div>
            </div>
          ) : null}

          {tab === "Intelligence" ? (
            <div className="space-y-4">
              <Card className="card-pad">
                <SectionTitle
                  title="Data source catalogue"
                  subtitle="Every investigated source with availability, licence and live adapter status"
                  right={
                    <div className="flex gap-2">
                      <button type="button" className="btn btn-sm btn-primary" onClick={runIngestion} disabled={busy === "ingest"}>
                        {busy === "ingest" ? "Ingesting…" : "Run ingestion"}
                      </button>
                      <button type="button" className="btn btn-sm" onClick={runMonitor} disabled={busy === "monitor"}>
                        {busy === "monitor" ? "Monitoring…" : "Run reroute monitor"}
                      </button>
                    </div>
                  }
                />
                {ingestSummary ? (
                  <div className="mb-3">
                    <Alert tone="blue">{ingestSummary}</Alert>
                  </div>
                ) : null}
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Source</th>
                        <th>Category</th>
                        <th>Status</th>
                        <th>Frequency</th>
                        <th>Auth</th>
                        <th>Licence</th>
                        <th>Reliability</th>
                        <th>Last run</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(intel?.sources ?? []).map((source) => (
                        <tr key={source.key}>
                          <td>
                            <p className="font-semibold">{source.name}</p>
                            <p className="text-[10px] text-slate-500">{source.notes}</p>
                          </td>
                          <td className="text-[11px]">{source.category}</td>
                          <td>
                            <Badge
                              tone={
                                source.runtimeStatus === "active"
                                  ? "green"
                                  : source.runtimeStatus === "degraded"
                                    ? "amber"
                                    : source.runtimeStatus === "planned"
                                      ? "blue"
                                      : "slate"
                              }
                            >
                              {source.runtimeStatus}
                            </Badge>
                            {source.lastError ? <p className="mt-1 text-[10px] text-red-300">{source.lastError}</p> : null}
                          </td>
                          <td className="text-[11px] text-slate-400">{source.updateFrequency}</td>
                          <td className="text-[11px] text-slate-400">{source.authentication}</td>
                          <td className="text-[11px] text-slate-400">{source.license}</td>
                          <td className="text-[11px]">{source.reliability}</td>
                          <td className="text-[11px] text-slate-400">
                            {source.lastRunAt ? new Date(source.lastRunAt).toLocaleTimeString() : "never"}
                            {source.lastItemCount > 0 ? ` · ${source.lastItemCount} items` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card className="card-pad">
                  <SectionTitle
                    title="Verification queue"
                    subtitle="Low-confidence or unmatched reports — never applied to routing until confirmed"
                    right={<Badge tone="amber">{intel?.pending.length ?? 0} pending</Badge>}
                  />
                  <div className="space-y-2">
                    {(intel?.pending ?? []).map((report) => (
                      <div key={report.id} className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-slate-100">{report.title}</p>
                          <Badge tone={report.confidence >= 0.7 ? "amber" : "red"}>
                            confidence {Math.round(report.confidence * 100)}%
                          </Badge>
                        </div>
                        <p className="text-[10px] text-slate-500">
                          {report.sourceName} · {report.category} · {report.severity} · road: {report.roadName ?? "unidentified"} ·
                          segments: {report.matchedSegmentIds.join(", ") || "none"}
                        </p>
                        <p className="mt-1 line-clamp-2 text-[11px] text-slate-400">{report.rawText}</p>
                        {report.disruptionId ? (
                          <div className="mt-2 flex gap-2">
                            <button
                              type="button"
                              className="btn btn-sm btn-success"
                              onClick={() => verifyReport(report.disruptionId!, "verify")}
                              disabled={busy === `verify-${report.disruptionId}`}
                            >
                              Verify & apply
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => verifyReport(report.disruptionId!, "reject")}
                              disabled={busy === `verify-${report.disruptionId}`}
                            >
                              Reject
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ))}
                    {(intel?.pending.length ?? 0) === 0 ? <EmptyState title="Queue empty" hint="All reports are either confirmed or below the reporting threshold." /> : null}
                  </div>
                </Card>

                <Card className="card-pad">
                  <SectionTitle title="Automatic rerouting log" subtitle="Every ETA change with its trigger" />
                  <div className="space-y-1.5">
                    {(intel?.reroutes ?? []).map((event) => (
                      <div key={event.id} className="rounded-lg border border-slate-800 bg-slate-950/50 px-2.5 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[11px] font-semibold text-slate-200">
                            {event.publicId ?? `request ${event.requestId}`} · {event.action}
                          </p>
                          <span className="text-[10px] text-slate-500">{new Date(event.createdAt).toLocaleTimeString()}</span>
                        </div>
                        <p className="text-[10px] text-slate-400">{event.reason}</p>
                        {event.oldEtaMinutes !== null ? (
                          <p className="text-[10px] text-sky-300">
                            ETA {event.oldEtaMinutes} → {event.newEtaMinutes ?? "—"} min
                          </p>
                        ) : null}
                      </div>
                    ))}
                    {(intel?.reroutes.length ?? 0) === 0 ? <EmptyState title="No reroute decisions yet" hint="Trigger a disruption on an active route to see the monitor act." /> : null}
                  </div>
                </Card>
              </div>

              <Card className="card-pad">
                <SectionTitle title="Ingestion runs" subtitle="Per-source fetch/parse/store results" />
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Run</th>
                        <th>Source</th>
                        <th>Status</th>
                        <th>Fetched</th>
                        <th>New</th>
                        <th>Updated</th>
                        <th>Flagged</th>
                        <th>Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(intel?.runs ?? []).map((run) => (
                        <tr key={run.id}>
                          <td>#{run.id}</td>
                          <td className="text-[11px]">{run.sourceKey}</td>
                          <td>
                            <Badge tone={run.status === "success" ? "green" : run.status === "partial" ? "amber" : "red"}>
                              {run.status}
                            </Badge>
                          </td>
                          <td>{run.itemsFetched}</td>
                          <td>{run.itemsCreated}</td>
                          <td>{run.itemsUpdated}</td>
                          <td>{run.itemsFlagged}</td>
                          <td className="max-w-[320px] text-[10px] text-slate-400">{run.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          ) : null}

          {tab === "Live tracking" ? <AdminLiveTracking driverId={focusDriverId} onDriverChange={setFocusDriverId} /> : null}

          {tab === "Create request" ? <AdminCreateRequest /> : null}

          {tab === "Ambulances" ? (
            <Card className="card-pad">
              <SectionTitle title="Ambulance fleet" subtitle="Update availability from here" />
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Driver</th>
                      <th>Position</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.ambulances.map((ambulance) => (
                      <tr key={ambulance.id}>
                        <td className="font-semibold">{ambulance.code}</td>
                        <td>{ambulance.type}</td>
                        <td>
                          <Badge tone={STATUS_TONE[ambulance.status] ?? "slate"}>{ambulance.status}</Badge>
                        </td>
                        <td>{stats.drivers.find((d) => d.id === ambulance.driverId)?.name ?? "—"}</td>
                        <td className="text-[11px] text-slate-400">
                          {ambulance.lat.toFixed(4)}, {ambulance.lng.toFixed(4)}
                        </td>
                        <td>
                          <select
                            className="input py-1 text-xs"
                            value={ambulance.status}
                            onChange={(event) =>
                              patch(
                                "/api/ambulances",
                                { id: ambulance.id, status: event.target.value },
                                `ambulance-${ambulance.id}`,
                                `${ambulance.code} marked ${event.target.value}`,
                              )
                            }
                          >
                            <option value="available">available</option>
                            <option value="assigned">assigned</option>
                            <option value="on_trip">on_trip</option>
                            <option value="offline">offline</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {tab === "Drivers" ? (
            <div className="space-y-4">
            <AddDriverForm
              ambulances={stats.ambulances.map((a) => ({ id: a.id, code: a.code, type: a.type, status: a.status, driverId: a.driverId }))}
              hospitals={stats.hospitals.map((h) => ({ id: h.id, name: h.name, city: h.city }))}
              onAdded={load}
            />
            <Card className="card-pad">
              <SectionTitle title="Registered drivers" subtitle="Duty status is controlled by the driver console" />
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Driver</th>
                      <th>Phone</th>
                      <th>Licence</th>
                      <th>Ambulance</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.drivers.map((driver) => (
                      <tr key={driver.id}>
                        <td className="font-semibold">{driver.name}</td>
                        <td className="text-[11px]">{driver.phone}</td>
                        <td className="text-[11px] text-slate-400">{driver.licenseNo}</td>
                        <td>{stats.ambulances.find((a) => a.id === driver.ambulanceId)?.code ?? "—"}</td>
                        <td>
                          <Badge tone={STATUS_TONE[driver.status] ?? "slate"}>{driver.status}</Badge>
                        </td>
                        <td className="space-x-1 whitespace-nowrap">
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => {
                              setFocusDriverId(driver.id);
                              setTab("Live tracking");
                            }}
                          >
                            Track on map
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() =>
                              patch(
                                "/api/drivers",
                                { id: driver.id, status: driver.status === "offline" ? "online" : "offline" },
                                `driver-${driver.id}`,
                                `${driver.name} marked ${driver.status === "offline" ? "online" : "offline"}`,
                              )
                            }
                          >
                            {driver.status === "offline" ? "Set online" : "Set offline"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            </div>
          ) : null}

          {tab === "Hospitals" ? (
            <Card className="card-pad">
              <SectionTitle title="Registered hospitals" subtitle="Capabilities are registered demo values" />
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Hospital</th>
                      <th>City</th>
                      <th>Emergency level</th>
                      <th>Facilities</th>
                      <th>Verified</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.hospitals.map((hospital) => (
                      <tr key={hospital.id}>
                        <td>
                          <p className="font-semibold">{hospital.name}</p>
                          <p className="text-[10px] text-slate-500">{hospital.code}</p>
                        </td>
                        <td>{hospital.city}</td>
                        <td>{hospital.emergencyLevel}</td>
                        <td className="text-[11px] text-slate-400">{hospital.facilities.slice(0, 5).join(", ")}</td>
                        <td>{hospital.verified ? "✅" : "—"}</td>
                        <td>
                          <Badge tone={hospital.status === "active" ? "green" : "slate"}>{hospital.status}</Badge>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() =>
                              patch(
                                "/api/hospitals",
                                { id: hospital.id, status: hospital.status === "active" ? "inactive" : "active" },
                                `hospital-${hospital.id}`,
                                `${hospital.name} ${hospital.status === "active" ? "deactivated" : "activated"}`,
                              )
                            }
                          >
                            {hospital.status === "active" ? "Deactivate" : "Activate"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {tab === "Disruptions" ? (
            <Card className="card-pad">
              <SectionTitle
                title="Road disruptions"
                subtitle="Active closures, accidents, construction, waterlogging and events"
                right={<Badge tone="red">{stats.disruptions.length} active</Badge>}
              />
              <div className="space-y-2">
                {stats.disruptions.map((disruption) => (
                  <div
                    key={disruption.id}
                    className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2"
                  >
                    <div>
                      <p className="text-xs font-semibold text-slate-100">
                        {disruptionIcon(disruption.type)} {disruption.title}
                      </p>
                      <p className="text-[10px] text-slate-500">
                        {disruptionLabel(disruption.type)} · {disruption.severity} severity · confidence{" "}
                        {Math.round((disruption.confidence ?? 1) * 100)}% · {disruption.verification ?? "verified"} ·{" "}
                        {disruption.sourceName ?? disruption.source} · reported by {disruption.reportedBy}
                      </p>
                      {disruption.description ? (
                        <p className="mt-0.5 text-[11px] text-slate-400">{disruption.description}</p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm btn-success"
                      onClick={() =>
                        patch(
                          "/api/disruptions",
                          { id: disruption.id, status: "resolved" },
                          `disruption-${disruption.id}`,
                          "Disruption resolved — routes recalculated",
                        )
                      }
                    >
                      Resolve
                    </button>
                  </div>
                ))}
                {stats.disruptions.length === 0 ? <EmptyState title="No active disruptions" /> : null}
              </div>
            </Card>
          ) : null}

          {tab === "Route history" ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="card-pad">
                <SectionTitle title="Computed routes" subtitle="Every dispatch and recalculation is stored" />
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Route</th>
                        <th>Request</th>
                        <th>Mode</th>
                        <th>Distance</th>
                        <th>Duration</th>
                        <th>Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.routes.map((route) => (
                        <tr key={route.id}>
                          <td>#{route.id}</td>
                          <td>{route.requestId ?? "—"}</td>
                          <td>{route.mode}</td>
                          <td>{formatDistance(route.distanceMeters)}</td>
                          <td>{formatDuration(route.durationSeconds)}</td>
                          <td className="text-[11px] text-slate-400">
                            {new Date(route.createdAt).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <Card className="card-pad">
                <SectionTitle title="Trips" subtitle="Pickup → hospital lifecycle" />
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Trip</th>
                        <th>Request</th>
                        <th>Status</th>
                        <th>Distance</th>
                        <th>Started</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.trips.map((trip) => (
                        <tr key={trip.id}>
                          <td>#{trip.id}</td>
                          <td>{trip.requestId}</td>
                          <td>
                            <Badge tone={STATUS_TONE[trip.status] ?? "slate"}>{statusLabel(trip.status)}</Badge>
                          </td>
                          <td>{trip.distanceKm ? `${trip.distanceKm.toFixed(1)} km` : "—"}</td>
                          <td className="text-[11px] text-slate-400">{new Date(trip.startedAt).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
