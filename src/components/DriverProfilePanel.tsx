"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Card, EmptyState, KeyValue, SectionTitle, Spinner } from "@/components/ui";
import { api } from "@/lib/useLive";
import { formatDistance, formatDuration } from "@/lib/geo";
import { categoryIcon, categoryLabel, statusLabel } from "@/lib/domain";
import { TRAFFIC_COLORS } from "@/lib/trafficView";
import type { DriverProfile } from "@/lib/driverProfileTypes";

const STAGE_TONE: Record<string, "red" | "amber" | "green" | "blue" | "slate"> = {
  assigned: "blue",
  to_patient: "amber",
  to_hospital: "red",
  at_hospital: "blue",
  available: "green",
  offline: "slate",
  idle: "slate",
};

const ASSIGNMENT_TONE: Record<string, "red" | "amber" | "green" | "blue" | "slate"> = {
  accepted: "green",
  rejected: "red",
  pending: "amber",
  expired: "slate",
};

function ago(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">{title}</p>
      {children}
    </div>
  );
}

function MixBar({ mix }: { mix: { green: number; orange: number; red: number } }) {
  return (
    <div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-slate-800">
        <span style={{ width: `${mix.green}%`, background: TRAFFIC_COLORS.green }} />
        <span style={{ width: `${mix.orange}%`, background: TRAFFIC_COLORS.orange }} />
        <span style={{ width: `${mix.red}%`, background: TRAFFIC_COLORS.red }} />
      </div>
      <p className="mt-1 text-[10px] text-slate-500">
        Traffic on route: {mix.green}% free · {mix.orange}% slowing · {mix.red}% heavy
      </p>
    </div>
  );
}

/**
 * Everything the control room knows about one driver, refreshed every 3 seconds: identity, login,
 * vehicle, live position and stage, the current trip, assignment log, trip history and totals.
 */
export default function DriverProfilePanel({ driverId, onClose }: { driverId: number; onClose?: () => void }) {
  const [profile, setProfile] = useState<DriverProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setError(null);
    const load = async () => {
      try {
        const next = await api<DriverProfile>(`/api/admin/drivers/${driverId}`);
        if (!cancelled) {
          setProfile(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Driver profile unavailable");
      }
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [driverId]);

  if (error && !profile) {
    return (
      <Card className="card-pad">
        <Alert tone="red">{error}</Alert>
      </Card>
    );
  }
  if (!profile) {
    return (
      <Card className="card-pad">
        <Spinner label="Loading driver profile…" />
      </Card>
    );
  }

  const { driver, login, vehicle, position, live, currentTrip, assignments, trips, stats } = profile;
  const onDuty = driver.status !== "offline";
  const stage = live.stage;

  return (
    <Card className="card-pad">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-base font-bold text-white">{driver.name}</p>
          <p className="text-[11px] text-slate-400">
            {vehicle ? `${vehicle.code} · ${vehicle.type}` : "No ambulance assigned"} · driver #{driver.id}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={onDuty ? "green" : "slate"}>{statusLabel(driver.status)}</Badge>
          <Badge tone={STAGE_TONE[stage] ?? "slate"}>{live.stageLabel}</Badge>
          {onClose ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
              Close
            </button>
          ) : null}
        </div>
      </div>
      {error ? <div className="mt-2"><Alert tone="amber">Showing the last received profile: {error}</Alert></div> : null}

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Section title="Driver">
          <KeyValue label="Full name" value={driver.name} />
          <KeyValue label="Phone" value={driver.phone ? <a className="text-sky-300 underline" href={`tel:${driver.phone.replace(/\s+/g, "")}`}>{driver.phone}</a> : "—"} />
          <KeyValue label="Licence" value={driver.licenseNo || "—"} />
          <KeyValue label="Duty status" value={statusLabel(driver.status)} />
          <KeyValue label="Registered" value={when(driver.createdAt)} />
        </Section>

        <Section title="Login">
          <KeyValue label="Username" value={login.username ?? "—"} />
          <KeyValue label="Email" value={login.email ?? "—"} />
          <KeyValue label="Role" value={login.role ?? "—"} />
        </Section>

        <Section title="Ambulance">
          {vehicle ? (
            <>
              <KeyValue label="Vehicle" value={`${vehicle.code} (${vehicle.type})`} />
              <KeyValue label="Vehicle status" value={statusLabel(vehicle.status)} />
              <KeyValue label="Base hospital" value={vehicle.base?.name ?? "—"} />
              <div className="mt-2 flex flex-wrap gap-1">
                {vehicle.facilities.length ? (
                  vehicle.facilities.map((f) => (
                    <span key={f} className="rounded-full border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300">
                      {f}
                    </span>
                  ))
                ) : (
                  <span className="text-[11px] text-slate-500">No equipment recorded</span>
                )}
              </div>
            </>
          ) : (
            <EmptyState title="No vehicle" hint="This driver is not linked to an ambulance." />
          )}
        </Section>

        <Section title="Live position">
          <KeyValue
            label="Ambulance (dispatch position)"
            value={
              position.ambulance
                ? `${position.ambulance.lat.toFixed(5)}, ${position.ambulance.lng.toFixed(5)} · ${ago(position.ambulance.updatedSecondsAgo)}`
                : "—"
            }
          />
          <KeyValue
            label="Device GPS (last report)"
            value={position.device ? `${position.device.lat.toFixed(5)}, ${position.device.lng.toFixed(5)} · ${ago(position.device.updatedSecondsAgo)}` : "—"}
          />
          <KeyValue label="Position source" value={position.ambulance?.source === "driver" ? "Device GPS on route" : position.ambulance?.source === "simulation" ? "Simulation (demo)" : "Road route engine"} />
          <KeyValue label="Speed" value={live.route ? `${Math.round(live.speedKph)} km/h` : "stationary"} />
          {live.route ? (
            <>
              <div className="mt-2 h-1.5 overflow-hidden rounded bg-slate-800">
                <div
                  className={`h-1.5 rounded ${live.route.purpose === "hospital" ? "bg-red-500" : "bg-amber-500"}`}
                  style={{ width: `${Math.round(live.progress * 100)}%` }}
                />
              </div>
              <KeyValue label="Progress" value={`${Math.round(live.progress * 100)}% of route`} />
              <KeyValue label="Remaining" value={`${formatDistance(live.remainingMeters)} · ${formatDuration(live.remainingSeconds)}`} />
            </>
          ) : null}
          {live.nextStop ? (
            <KeyValue label="Next stop" value={`${live.nextStop.kind === "patient" ? "🧍 Patient" : "🏥 Hospital"}: ${live.nextStop.name}`} />
          ) : null}
        </Section>

        <Section title="Route">
          {live.route ? (
            <>
              <KeyValue label="Route" value={live.route.optionLabel ?? "Auto-assigned fastest road route"} />
              <KeyValue label="Leg" value={live.route.purpose === "hospital" ? "Patient on board → hospital" : "Driving to patient"} />
              <KeyValue label="Distance" value={formatDistance(live.route.distanceMeters)} />
              <KeyValue label="Planned time" value={formatDuration(live.route.durationSeconds)} />
              <KeyValue label="Search" value={live.route.algorithm ?? "road routing"} />
              <KeyValue label="Chosen at" value={when(live.route.chosenAt)} />
              {live.route.trafficMix ? (
                <div className="mt-2">
                  <MixBar mix={live.route.trafficMix} />
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState title="No active route" hint="The route appears when the driver is on a trip." />
          )}
        </Section>

        <Section title="Current trip">
          {currentTrip ? (
            <>
              <KeyValue label="Request" value={`${currentTrip.publicId} (${statusLabel(currentTrip.status)})`} />
              <KeyValue label="Category" value={`${categoryIcon(currentTrip.category)} ${categoryLabel(currentTrip.category)}`} />
              <KeyValue label="Severity" value={currentTrip.severity.toUpperCase()} />
              <KeyValue label="Patient" value={`${currentTrip.patient.name} · ${currentTrip.patient.phone || "no phone"}`} />
              <KeyValue label="Pickup" value={currentTrip.pickup.address || `${currentTrip.pickup.lat.toFixed(4)}, ${currentTrip.pickup.lng.toFixed(4)}`} />
              <KeyValue label="Hospital" value={currentTrip.hospital ? `${currentTrip.hospital.name}` : "—"} />
              {currentTrip.hospital ? (
                <KeyValue label="Hospital contact" value={`${currentTrip.hospital.address}${currentTrip.hospital.phone ? ` · ${currentTrip.hospital.phone}` : ""}`} />
              ) : null}
              <KeyValue label="ETA" value={currentTrip.etaMinutes !== null ? `${currentTrip.etaMinutes} min` : "—"} />
              <KeyValue label="Started" value={when(currentTrip.startedAt)} />
              {currentTrip.timeline.length > 0 ? (
                <div className="mt-2 space-y-0.5">
                  {currentTrip.timeline.map((entry) => (
                    <p key={entry.key} className={`text-[11px] ${entry.at ? "text-emerald-300" : "text-slate-600"}`}>
                      {entry.at ? "✓" : "○"} {entry.label}
                      {entry.at ? ` · ${new Date(entry.at).toLocaleTimeString()}` : ""}
                    </p>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState title="No active trip" hint="Assigned emergencies appear here with the patient and hospital." />
          )}
        </Section>

        <Section title="Totals">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md border border-slate-800 p-2">
              <p className="text-lg font-bold text-white">{stats.completedTrips}</p>
              <p className="text-[10px] text-slate-500">completed trips</p>
            </div>
            <div className="rounded-md border border-slate-800 p-2">
              <p className="text-lg font-bold text-white">{stats.totalDistanceKm} km</p>
              <p className="text-[10px] text-slate-500">distance driven</p>
            </div>
            <div className="rounded-md border border-slate-800 p-2">
              <p className="text-lg font-bold text-white">{stats.pickups}</p>
              <p className="text-[10px] text-slate-500">patients picked up</p>
            </div>
            <div className="rounded-md border border-slate-800 p-2">
              <p className="text-lg font-bold text-white">
                {stats.assignmentsAccepted} / {stats.assignmentsRejected}
              </p>
              <p className="text-[10px] text-slate-500">accepted / rejected</p>
            </div>
          </div>
        </Section>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Section title={`Assignments (last ${assignments.length})`}>
          {assignments.length === 0 ? (
            <p className="text-[11px] text-slate-500">No assignments yet.</p>
          ) : (
            <div className="space-y-1.5">
              {assignments.map((a) => (
                <div key={a.id} className="flex items-start justify-between gap-2 text-[11px]">
                  <div>
                    <p className="font-semibold text-slate-200">{a.publicId}</p>
                    <p className="text-[10px] text-slate-500">
                      {when(a.createdAt)}
                      {a.reason ? ` · ${a.reason}` : ""}
                    </p>
                  </div>
                  <Badge tone={ASSIGNMENT_TONE[a.status] ?? "slate"}>{statusLabel(a.status)}</Badge>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title={`Trip history (last ${trips.length})`}>
          {trips.length === 0 ? (
            <p className="text-[11px] text-slate-500">No trips yet.</p>
          ) : (
            <div className="space-y-1.5">
              {trips.map((t) => (
                <div key={t.id} className="flex items-start justify-between gap-2 text-[11px]">
                  <div>
                    <p className="font-semibold text-slate-200">
                      {t.publicId} · {t.patientName}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      {when(t.startedAt)} · {t.distanceKm} km · {formatDuration(t.durationSeconds)}
                    </p>
                  </div>
                  <Badge tone={t.status === "completed" ? "green" : t.status === "cancelled" ? "slate" : "amber"}>
                    {statusLabel(t.status)}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </Card>
  );
}
