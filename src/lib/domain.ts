export const ROLES = ["patient", "driver", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const EMERGENCY_CATEGORIES = [
  { value: "cardiac", label: "Cardiac / Heart Attack", icon: "❤️", requiredFacilities: ["cardiac", "icu"] },
  { value: "stroke", label: "Stroke / Neuro", icon: "🧠", requiredFacilities: ["neuro", "icu"] },
  { value: "trauma", label: "Road Accident / Trauma", icon: "🚑", requiredFacilities: ["trauma", "icu"] },
  { value: "respiratory", label: "Respiratory / Breathing", icon: "🫁", requiredFacilities: ["icu", "oxygen"] },
  { value: "obstetric", label: "Pregnancy / Obstetric", icon: "🤰", requiredFacilities: ["obstetric", "nicu"] },
  { value: "pediatric", label: "Child / Pediatric", icon: "🧒", requiredFacilities: ["pediatric", "nicu"] },
  { value: "burns", label: "Burns", icon: "🔥", requiredFacilities: ["burns", "icu"] },
  { value: "poisoning", label: "Poisoning / Snake Bite", icon: "☠️", requiredFacilities: ["icu", "emergency"] },
  { value: "other", label: "Other Emergency", icon: "🚨", requiredFacilities: ["emergency"] },
] as const;

export type EmergencyCategory = (typeof EMERGENCY_CATEGORIES)[number]["value"];

export const SEVERITIES = ["critical", "serious", "stable"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const REQUEST_STATUSES = [
  "pending",
  "assigned",
  "accepted",
  "enroute_pickup",
  "arrived_pickup",
  "enroute_hospital",
  "arrived_hospital",
  "completed",
  "cancelled",
  "rejected",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const TRIP_STATUSES = ["to_pickup", "at_pickup", "to_hospital", "completed", "cancelled"] as const;

export const DISRUPTION_TYPES = [
  { value: "accident", label: "Accident", icon: "💥", blocks: false },
  { value: "construction", label: "Construction work", icon: "🚧", blocks: false },
  { value: "metro_work", label: "Metro construction", icon: "🚇", blocks: false },
  { value: "drainage", label: "Drainage work", icon: "🕳️", blocks: false },
  { value: "pipeline", label: "Pipeline work", icon: "🔧", blocks: false },
  { value: "diversion", label: "Road diversion", icon: "↪️", blocks: false },
  { value: "waterlogging", label: "Waterlogging", icon: "🌊", blocks: true },
  { value: "damaged_road", label: "Damaged road", icon: "🪨", blocks: true },
  { value: "public_event", label: "Public event", icon: "🎪", blocks: false },
  { value: "closure", label: "Full road closure", icon: "⛔", blocks: true },
  { value: "traffic", label: "Heavy traffic", icon: "🚗", blocks: false },
] as const;

export type DisruptionType = (typeof DISRUPTION_TYPES)[number]["value"];

export const DISRUPTION_SEVERITIES = ["low", "moderate", "high", "critical"] as const;
export type DisruptionSeverity = (typeof DISRUPTION_SEVERITIES)[number];

export const SEVERITY_MULTIPLIER: Record<DisruptionSeverity, number> = {
  low: 1.15,
  moderate: 1.35,
  high: 1.7,
  critical: 2.8,
};

export const AMBULANCE_TYPES = ["BLS", "ALS", "ICU", "Neonatal"] as const;
export type AmbulanceType = (typeof AMBULANCE_TYPES)[number];

export const AMBULANCE_STATUSES = ["available", "assigned", "on_trip", "offline"] as const;

export const FACILITY_OPTIONS = [
  "emergency",
  "icu",
  "trauma",
  "cardiac",
  "neuro",
  "obstetric",
  "nicu",
  "pediatric",
  "burns",
  "oxygen",
  "dialysis",
  "surgery",
] as const;

export const STATUS_LABELS: Record<string, string> = {
  pending: "Finding ambulance",
  assigned: "Ambulance assigned",
  accepted: "Driver accepted",
  enroute_pickup: "Ambulance en route to pickup",
  arrived_pickup: "Ambulance at pickup",
  enroute_hospital: "Patient on board — to hospital",
  arrived_hospital: "Arrived at hospital",
  completed: "Trip completed",
  cancelled: "Cancelled",
  rejected: "Reassigned",
  available: "Available",
  on_trip: "On trip",
  offline: "Offline",
  active: "Active",
  resolved: "Resolved",
  open: "Open",
  restricted: "Restricted",
  closed: "Closed",
  to_pickup: "To pickup",
  at_pickup: "At pickup",
  to_hospital: "To hospital",
};

export const STATUS_TONE: Record<string, "red" | "amber" | "green" | "blue" | "slate"> = {
  pending: "amber",
  assigned: "blue",
  accepted: "blue",
  enroute_pickup: "blue",
  arrived_pickup: "amber",
  enroute_hospital: "green",
  arrived_hospital: "green",
  completed: "slate",
  cancelled: "slate",
  rejected: "amber",
  available: "green",
  on_trip: "amber",
  offline: "slate",
  active: "red",
  resolved: "slate",
  open: "green",
  restricted: "amber",
  closed: "red",
  to_pickup: "blue",
  at_pickup: "amber",
  to_hospital: "green",
};

export const TRAFFIC_TONE: Record<string, "green" | "amber" | "red"> = {
  low: "green",
  moderate: "amber",
  heavy: "red",
  severe: "red",
};

export function categoryLabel(value: string): string {
  return EMERGENCY_CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

export function categoryIcon(value: string): string {
  return EMERGENCY_CATEGORIES.find((c) => c.value === value)?.icon ?? "🚨";
}

export function disruptionLabel(value: string): string {
  return DISRUPTION_TYPES.find((d) => d.value === value)?.label ?? value;
}

export function disruptionIcon(value: string): string {
  return DISRUPTION_TYPES.find((d) => d.value === value)?.icon ?? "⚠️";
}

export function statusLabel(value: string): string {
  return STATUS_LABELS[value] ?? value.replace(/_/g, " ");
}

/** Suitability score for a hospital given the emergency category. */
export function hospitalSuitability(
  hospital: { facilities: string[]; traumaLevel: string; emergencyLevel: string },
  category: string,
): { score: number; matched: string[]; missing: string[] } {
  const required = EMERGENCY_CATEGORIES.find((c) => c.value === category)?.requiredFacilities ?? ["emergency"];
  const facilities = hospital.facilities ?? [];
  const matched = required.filter((f) => facilities.includes(f));
  const missing = required.filter((f) => !facilities.includes(f));
  let score = (matched.length / Math.max(1, required.length)) * 70;
  if (hospital.traumaLevel) score += 10;
  if (hospital.emergencyLevel === "Level I") score += 10;
  else if (hospital.emergencyLevel === "Level II") score += 6;
  else score += 3;
  return { score: Math.round(Math.min(100, score)), matched, missing };
}
