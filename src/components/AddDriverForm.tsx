"use client";

import { useState } from "react";
import { Alert, Card, SectionTitle } from "@/components/ui";
import { api } from "@/lib/useLive";
import { isHindiName, suggestHindiName, FIRST_NAMES, SURNAMES } from "@/lib/hindiNames";
import { slugName } from "@/lib/loginName";

export type FreeAmbulance = { id: number; code: string; type: string; status: string; driverId: number | null };
export type BaseHospital = { id: number; name: string; city: string };

type Created = { name: string; username: string; email: string; password: string; vehicle: string | null };

/**
 * Admin form to register a new driver. Names must be approved Hindu names; the login is created from
 * the name (for example rakesh.patel) and an unassigned ambulance can be attached immediately.
 */
export default function AddDriverForm({
  ambulances,
  hospitals,
  onAdded,
}: {
  ambulances: FreeAmbulance[];
  hospitals: BaseHospital[];
  onAdded: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [licenseNo, setLicenseNo] = useState("");
  const [vehicleChoice, setVehicleChoice] = useState<"none" | "new" | number>("none");
  const [newType, setNewType] = useState("BLS");
  const [newHospitalId, setNewHospitalId] = useState<number | "">("");
  const [password, setPassword] = useState("driver123");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const free = ambulances.filter((a) => a.driverId === null);
  const nameValid = name.trim() === "" || isHindiName(name);
  const preview = name.trim() && isHindiName(name) ? slugName(name) : null;

  const submit = async () => {
    setError(null);
    setCreated(null);
    if (!name.trim()) return setError("Enter the driver's name, or use Suggest name.");
    if (!isHindiName(name)) return setError("Use an approved Hindu name (first name and surname). Click Suggest name for a valid one.");
    if (password.length < 6) return setError("The password must be at least 6 characters.");
    setBusy(true);
    try {
      if (vehicleChoice === "new" && newHospitalId === "") return setError("Choose the base hospital for the new ambulance.");
      const data = await api<{
        driver: { name: string };
        vehicle: string | null;
        login: { username: string; email: string; password: string };
      }>("/api/drivers", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          licenseNo: licenseNo.trim(),
          ambulanceId: typeof vehicleChoice === "number" ? vehicleChoice : null,
          newAmbulance: vehicleChoice === "new" ? { type: newType, hospitalId: newHospitalId } : null,
          password,
        }),
      });
      setCreated({
        name: data.driver.name,
        username: data.login.username,
        email: data.login.email,
        password: data.login.password,
        vehicle: data.vehicle,
      });
      setName("");
      setPhone("");
      setLicenseNo("");
      setVehicleChoice("none");
      await onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The driver could not be added");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="card-pad">
      <SectionTitle
        title="Add a driver"
        subtitle="Approved Hindu names only. The login is created from the name; attach a free ambulance now or later."
      />
      <div className="grid gap-3 md:grid-cols-2">
        <div className="md:col-span-2">
          <label className="label" htmlFor="new-driver-name">
            Full name
          </label>
          <div className="flex gap-2">
            <input
              id="new-driver-name"
              className={`input ${nameValid ? "" : "border-red-500/70"}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Ketan Thakkar"
            />
            <button type="button" className="btn btn-sm whitespace-nowrap" onClick={() => setName(suggestHindiName())}>
              Suggest name
            </button>
          </div>
          <p className="mt-1 text-[10px] text-slate-500">
            {nameValid
              ? preview
                ? `Login username will be ${preview}`
                : `Approved first names: ${FIRST_NAMES.length} · surnames: ${SURNAMES.length}`
              : "Not an approved Hindu name. Use a first name and surname from the list."}
          </p>
        </div>
        <div>
          <label className="label" htmlFor="new-driver-phone">
            Phone
          </label>
          <input id="new-driver-phone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 …" />
        </div>
        <div>
          <label className="label" htmlFor="new-driver-licence">
            Licence number
          </label>
          <input id="new-driver-licence" className="input" value={licenseNo} onChange={(e) => setLicenseNo(e.target.value)} placeholder="GJ-DL-…" />
        </div>
        <div>
          <label className="label" htmlFor="new-driver-vehicle">
            Ambulance
          </label>
          <select
            id="new-driver-vehicle"
            className="input"
            value={vehicleChoice === "none" || vehicleChoice === "new" ? vehicleChoice : String(vehicleChoice)}
            onChange={(e) => {
              const value = e.target.value;
              setVehicleChoice(value === "none" || value === "new" ? value : Number(value));
            }}
          >
            <option value="none">Not assigned yet</option>
            <option value="new">+ New ambulance at a base hospital</option>
            {free.map((a) => (
              <option key={a.id} value={a.id}>
                Existing: {a.code} · {a.type} · {a.status}
              </option>
            ))}
          </select>
          {free.length === 0 ? <p className="mt-1 text-[10px] text-slate-500">No unassigned ambulances — create a new one.</p> : null}
        </div>
        {vehicleChoice === "new" ? (
          <>
            <div>
              <label className="label" htmlFor="new-ambulance-type">
                New ambulance type
              </label>
              <select id="new-ambulance-type" className="input" value={newType} onChange={(e) => setNewType(e.target.value)}>
                <option value="BLS">BLS (basic life support)</option>
                <option value="ALS">ALS (advanced life support)</option>
                <option value="ICU">ICU</option>
                <option value="Neonatal">Neonatal</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="new-ambulance-hospital">
                Base hospital
              </label>
              <select
                id="new-ambulance-hospital"
                className="input"
                value={newHospitalId}
                onChange={(e) => setNewHospitalId(e.target.value ? Number(e.target.value) : "")}
              >
                <option value="">Choose a hospital…</option>
                {hospitals.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} — {h.city}
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : null}
        <div>
          <label className="label" htmlFor="new-driver-password">
            Initial password
          </label>
          <input id="new-driver-password" type="text" className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      </div>
      {error ? (
        <div className="mt-3">
          <Alert tone="red">{error}</Alert>
        </div>
      ) : null}
      {created ? (
        <div className="mt-3">
          <Alert tone="green">
            Driver <strong>{created.name}</strong> added{created.vehicle ? ` and assigned to ${created.vehicle}` : " (no ambulance yet)"}. Login:{" "}
            <strong>{created.username}</strong> (or {created.email}) · password <strong>{created.password}</strong>. Share these with the driver.
          </Alert>
        </div>
      ) : null}
      <button type="button" className="btn btn-primary mt-3 w-full" onClick={submit} disabled={busy}>
        {busy ? "Adding driver…" : "Add driver"}
      </button>
    </Card>
  );
}
