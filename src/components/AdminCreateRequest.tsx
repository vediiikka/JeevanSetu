"use client";

import { useEffect, useState } from "react";
import MapView from "@/components/MapView";
import { Alert, Badge, Card, KeyValue, SectionTitle } from "@/components/ui";
import { api } from "@/lib/useLive";
import { formatDistance, formatDuration, formatEta } from "@/lib/geo";
import { EMERGENCY_CATEGORIES, SEVERITIES, categoryIcon, categoryLabel, statusLabel } from "@/lib/domain";

type HospitalOption = { id: number; name: string; city: string; emergencyLevel: string; status: string };

type CandidateView = {
  ambulanceId: number;
  code: string;
  type: string;
  status: "selected" | "ranked" | "unreachable" | "unavailable";
  roadDistanceMeters: number | null;
  roadDurationSeconds: number | null;
  straightLineMeters: number;
  reason: string;
};

type CreatedResult = {
  ambulanceCandidates?: CandidateView[];
  request: { id: number; publicId: string; status: string; etaMinutes: number | null; distanceKm: number | null; channel?: string };
  hospital: { id: number; name: string } | null;
  candidates: { hospitalId: number; name: string; durationSeconds: number; distanceMeters: number; suitability: number }[];
  assignment: {
    ambulance: { code: string; type: string };
    driver: { name: string; phone: string } | null;
    route: { durationSeconds: number; distanceMeters: number; engine?: string } | null;
  } | null;
};

type RecentRequest = {
  id: number;
  publicId: string;
  patientName: string;
  category: string;
  status: string;
  channel?: string;
  createdAt: string;
};

const DEFAULT_CENTRE = { lat: 23.0225, lng: 72.5714 };

export default function AdminCreateRequest({ onCreated }: { onCreated?: (result: CreatedResult) => void }) {
  const [form, setForm] = useState({
    patientName: "",
    patientPhone: "",
    category: "cardiac",
    severity: "critical",
    mode: "nearest" as "nearest" | "desired",
    preferredHospitalId: 0,
    notes: "",
  });
  const [coords, setCoords] = useState(DEFAULT_CENTRE);
  const [address, setAddress] = useState("Ahmedabad city centre (pin)");
  const [hospitals, setHospitals] = useState<HospitalOption[]>([]);
  const [recent, setRecent] = useState<RecentRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatedResult | null>(null);

  const loadRecent = async () => {
    try {
      const data = await api<{ requests: RecentRequest[] }>("/api/requests");
      setRecent(data.requests.slice(0, 8));
    } catch {
      setRecent([]);
    }
  };

  useEffect(() => {
    void api<{ hospitals: HospitalOption[] }>("/api/hospitals")
      .then((data) => setHospitals(data.hospitals.filter((h) => h.status === "active")))
      .catch(() => setHospitals([]));
    void loadRecent();
  }, []);

  const pin = async (lat: number, lng: number) => {
    setCoords({ lat, lng });
    setAddress(`Pin (${lat.toFixed(4)}, ${lng.toFixed(4)})`);
    try {
      const geo = await api<{ shortAddress: string | null }>(`/api/geocode?lat=${lat}&lng=${lng}`);
      if (geo.shortAddress) setAddress(geo.shortAddress);
    } catch {
      /* keep the coordinate label */
    }
  };

  const useMyLocation = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("This browser cannot provide a location. Click the map to place the pickup.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => void pin(position.coords.latitude, position.coords.longitude),
      () => setError("Location permission denied. Click the map to place the pickup."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const submit = async () => {
    setError(null);
    setResult(null);
    if (!form.patientName.trim() || !form.patientPhone.trim()) {
      setError("Patient name and contact number are required.");
      return;
    }
    if (!/^[0-9]{10}$/.test(form.patientPhone)) {
      setError("Contact number must contain exactly 10 digits.");
      return;
    }
    if (form.mode === "desired" && !form.preferredHospitalId) {
      setError("Select the destination hospital for desired-hospital mode.");
      return;
    }
    setBusy(true);
    try {
      const data = await api<CreatedResult>("/api/requests", {
        method: "POST",
        body: JSON.stringify({
          channel: "control_room",
          patientName: form.patientName,
          patientPhone: form.patientPhone,
          category: form.category,
          severity: form.severity,
          mode: form.mode,
          preferredHospitalId: form.mode === "desired" ? form.preferredHospitalId : null,
          notes: form.notes,
          lat: coords.lat,
          lng: coords.lng,
          pickupAddress: address,
        }),
      });
      setResult(data);
      onCreated?.(data);
      void loadRecent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The request could not be created");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-request-layout grid gap-5">
      <div className="admin-request-data space-y-4">
      <Card className="card-pad">
        <SectionTitle
          title="Create emergency request"
          subtitle="Phone or walk-in intake by the control room — dispatched exactly like an app request"
        />
        <div className="grid gap-4">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label" htmlFor="adm-name">Patient name</label>
                <input id="adm-name" className="input" required value={form.patientName}
                  onChange={(e) => setForm((p) => ({ ...p, patientName: e.target.value }))} placeholder="Full name" />
              </div>
              <div>
                <label className="label" htmlFor="adm-phone">Contact number</label>
                <input id="adm-phone" className="input" type="tel" inputMode="numeric" pattern="[0-9]{10}"
                  minLength={10} required value={form.patientPhone}
                  onChange={(e) => setForm((p) => ({ ...p, patientPhone: e.target.value.replace(/[^0-9]/g, "").slice(0, 10) }))}
                  placeholder="10-digit mobile number" />
              </div>
            </div>

            <div>
              <span className="label">Emergency category</span>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {EMERGENCY_CATEGORIES.map((category) => (
                  <button key={category.value} type="button"
                    onClick={() => setForm((p) => ({ ...p, category: category.value }))}
                    className={`rounded-lg border px-2 py-1.5 text-left text-[11px] font-semibold transition ${
                      form.category === category.value
                        ? "border-red-500/70 bg-red-500/15 text-red-200"
                        : "border-slate-700 bg-slate-950/50 text-slate-300 hover:border-slate-500"
                    }`}>
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
                  <button key={severity} type="button"
                    onClick={() => setForm((p) => ({ ...p, severity }))}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-[11px] font-bold uppercase tracking-wide ${
                      form.severity === severity
                        ? "border-red-500/70 bg-red-500/15 text-red-200"
                        : "border-slate-700 bg-slate-950/50 text-slate-400"
                    }`}>
                    {severity}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="label">Hospital</span>
              <div className="flex gap-1.5">
                <button type="button" onClick={() => setForm((p) => ({ ...p, mode: "nearest" }))}
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-[11px] font-bold uppercase tracking-wide ${
                    form.mode === "nearest" ? "border-sky-500/70 bg-sky-500/15 text-sky-200" : "border-slate-700 bg-slate-950/50 text-slate-400"
                  }`}>
                  Nearest suitable
                </button>
                <button type="button" onClick={() => setForm((p) => ({ ...p, mode: "desired" }))}
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-[11px] font-bold uppercase tracking-wide ${
                    form.mode === "desired" ? "border-sky-500/70 bg-sky-500/15 text-sky-200" : "border-slate-700 bg-slate-950/50 text-slate-400"
                  }`}>
                  Desired hospital
                </button>
              </div>
              {form.mode === "desired" ? (
                <select className="input mt-2" value={form.preferredHospitalId}
                  onChange={(e) => setForm((p) => ({ ...p, preferredHospitalId: Number(e.target.value) }))}>
                  <option value={0}>Select a registered hospital…</option>
                  {hospitals.map((h) => (
                    <option key={h.id} value={h.id}>{h.name} — {h.city} ({h.emergencyLevel})</option>
                  ))}
                </select>
              ) : (
                <p className="mt-1 text-[11px] text-slate-500">The fastest suitable hospital by road time is chosen automatically.</p>
              )}
            </div>

            <div>
              <label className="label" htmlFor="adm-notes">Call notes</label>
              <textarea id="adm-notes" className="input min-h-[56px]" value={form.notes}
                onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
                placeholder="Landmark, caller relationship, patient condition…" />
            </div>
          </div>

        </div>

        {error ? <div className="mt-4"><Alert tone="red">{error}</Alert></div> : null}

        <button type="button" className="btn btn-primary mt-4 w-full py-2.5" onClick={submit} disabled={busy}>
          {busy ? "Dispatching…" : "🚨 Create request & dispatch ambulance"}
        </button>
      </Card>

      <div className="space-y-4">
        {result ? (
          <Card className="card-pad">
            <SectionTitle
              title={`Request ${result.request.publicId} created`}
              subtitle={`${categoryIcon(form.category)} ${categoryLabel(form.category)} · ${form.severity}`}
              right={<Badge tone="green">{statusLabel(result.request.status)}</Badge>}
            />
            {result.assignment ? (
              <>
                <KeyValue label="Ambulance" value={`${result.assignment.ambulance.code} (${result.assignment.ambulance.type})`} />
                <KeyValue label="Driver" value={result.assignment.driver ? `${result.assignment.driver.name} · ${result.assignment.driver.phone}` : "—"} />
                <KeyValue label="ETA to patient" value={formatEta(result.request.etaMinutes)} />
                <KeyValue label="Road distance" value={result.request.distanceKm ? `${result.request.distanceKm} km` : "—"} />
                <KeyValue label="Route engine" value={result.assignment.route?.engine?.toUpperCase() ?? "ROAD ROUTE"} />
              </>
            ) : (
              <Alert tone="amber">No ambulance is free right now. The request is queued and will be dispatched when a unit becomes available.</Alert>
            )}
            <KeyValue label="Destination" value={result.hospital?.name ?? "—"} />
            {result.ambulanceCandidates?.length ? (
              <div className="mt-3 space-y-1">
                <p className="label">Ambulances — closest by road first</p>
                {[...result.ambulanceCandidates]
                  .sort((a, b) => {
                    const order = { selected: 0, ranked: 1, unreachable: 2, unavailable: 3 } as const;
                    return order[a.status] - order[b.status] || (a.roadDurationSeconds ?? 1e9) - (b.roadDurationSeconds ?? 1e9);
                  })
                  .map((c) => (
                    <p key={c.ambulanceId} className={`text-[11px] ${c.status === "selected" ? "text-emerald-300" : "text-slate-400"}`}>
                      {c.status === "selected" ? "★ " : ""}{c.code} ({c.type}) · {c.roadDistanceMeters !== null ? formatDistance(c.roadDistanceMeters) : "—"} ·{" "}
                      {c.roadDurationSeconds !== null ? formatDuration(c.roadDurationSeconds) : "—"} by road · {c.reason}
                    </p>
                  ))}
              </div>
            ) : null}
            {result.candidates.length > 0 ? (
              <div className="mt-3 space-y-1">
                <p className="label">Hospitals ranked by road time</p>
                {result.candidates.map((c, index) => (
                  <p key={c.hospitalId} className="text-[11px] text-slate-400">
                    {index === 0 ? "★ " : ""}{c.name} · {formatDuration(c.durationSeconds)} · {formatDistance(c.distanceMeters)} · {c.suitability}% fit
                  </p>
                ))}
              </div>
            ) : null}
            <p className="mt-3 text-[11px] text-emerald-300">Open the Live tracking tab to follow this ambulance on the road.</p>
          </Card>
        ) : null}

        <Card className="card-pad">
          <SectionTitle title="Recent requests" subtitle="App and control-room intake" />
          <div className="space-y-1.5">
            {recent.map((item) => (
              <div key={item.id} className="rounded-lg border border-slate-800 bg-slate-950/50 px-2.5 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold text-slate-200">
                    {categoryIcon(item.category)} {item.publicId} · {item.patientName}
                  </p>
                  <Badge tone={item.channel === "control_room" ? "blue" : "slate"}>
                    {item.channel === "control_room" ? "control room" : "app"}
                  </Badge>
                </div>
                <p className="text-[10px] text-slate-500">
                  {statusLabel(item.status)} · {new Date(item.createdAt).toLocaleTimeString()}
                </p>
              </div>
            ))}
            {recent.length === 0 ? <p className="text-xs text-slate-500">No requests yet.</p> : null}
          </div>
        </Card>
      </div>
      </div>

      <Card className="card-pad admin-request-map-panel">
        <SectionTitle title="Pickup location" subtitle="Click the map to move the pickup pin" />
        <div className="mb-2 flex flex-wrap gap-2">
          <button type="button" className="btn btn-sm flex-1" onClick={useMyLocation}>📍 Use my location</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void pin(DEFAULT_CENTRE.lat, DEFAULT_CENTRE.lng)}>
            Ahmedabad centre
          </button>
        </div>
        <p className="mb-2 text-[11px] text-slate-400">{address} · {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}</p>
        <MapView
          center={[coords.lat, coords.lng]}
          zoom={13}
          markers={[{ id: "pickup", lat: coords.lat, lng: coords.lng, kind: "patient", label: "Pickup", detail: address }]}
          onMapClick={(lat, lng) => void pin(lat, lng)}
          className="admin-request-map"
        />
      </Card>
    </div>
  );
}
