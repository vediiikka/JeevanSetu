/**
 * JeevanSetu MongoDB document model (database: `jeevansetu_db`).
 *
 * Every collection is a real MongoDB collection. Documents use camelCase keys,
 * a numeric `id` (atomic counter) and the driver's `ObjectId` as `_id`.
 * GeoJSON payloads (LineString / Point) are stored as arrays of `[lng, lat]`
 * pairs, and `geohash` prefixes support proximity queries — the equivalent of
 * the 2dsphere indexes in the original specification.
 */
import { defineCollection } from "./query";

export type User = {
  id: number;
  name: string;
  email: string;
  phone: string;
  role: string; // patient | driver | admin
  passwordHash: string;
  createdAt: Date;
};

export type Session = {
  id: number;
  token: string;
  userId: number;
  role: string;
  expiresAt: Date;
  createdAt: Date;
};

export type Hospital = {
  id: number;
  code: string;
  name: string;
  address: string;
  city: string;
  district: string;
  lat: number;
  lng: number;
  geohash: string;
  phone: string;
  emergencyLevel: string;
  traumaLevel: string;
  facilities: string[];
  capabilities: string[];
  verified: boolean;
  status: string;
  createdAt: Date;
};

export type Driver = {
  id: number;
  userId: number | null;
  name: string;
  phone: string;
  licenseNo: string;
  status: string; // online | offline | on_trip
  lat: number | null;
  lng: number | null;
  geohash: string;
  ambulanceId: number | null;
  lastSeenAt: Date | null;
  createdAt: Date;
};

export type Ambulance = {
  id: number;
  code: string;
  type: string;
  status: string; // available | assigned | on_trip | offline
  lat: number;
  lng: number;
  geohash: string;
  driverId: number | null;
  hospitalId: number | null;
  facilities: string[];
  lastSeenAt: Date | null;
  /** driver = real GPS, engine = server-side route simulation */
  movementSource?: string;
  createdAt: Date;
};

export type Patient = {
  id: number;
  name: string;
  phone: string;
  lat: number;
  lng: number;
  geohash: string;
  address: string;
  createdAt: Date;
};

export type EmergencyRequest = {
  id: number;
  publicId: string;
  patientId: number | null;
  patientName: string;
  patientPhone: string;
  category: string;
  severity: string;
  status: string;
  mode: string;
  preferredHospitalId: number | null;
  hospitalId: number | null;
  ambulanceId: number | null;
  driverId: number | null;
  pickupLat: number;
  pickupLng: number;
  pickupAddress: string;
  etaMinutes: number | null;
  distanceKm: number | null;
  notes: string;
  /** app = patient/driver app, control_room = admin-created request */
  channel: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

export type AmbulanceAssignment = {
  id: number;
  requestId: number;
  ambulanceId: number;
  driverId: number | null;
  status: string; // pending | accepted | rejected | expired
  reason: string;
  createdAt: Date;
  respondedAt: Date | null;
};

export type Trip = {
  id: number;
  requestId: number;
  ambulanceId: number;
  driverId: number;
  status: string; // to_pickup | at_pickup | to_hospital | completed | cancelled
  startedAt: Date;
  acceptedAt: Date | null;
  arrivedPickupAt: Date | null;
  pickedUpAt: Date | null;
  arrivedHospitalAt: Date | null;
  completedAt: Date | null;
  distanceKm: number;
  durationSeconds: number;
};

export type RoadSegment = {
  id: number;
  segmentCode: string;
  roadName: string;
  city: string;
  district: string;
  roadClass: string;
  startNode: string;
  endNode: string;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  geometry: [number, number][];
  distanceMeters: number;
  baseSpeedKph: number;
  trafficLevel: string;
  status: string;
  severity: number;
  createdAt: Date;
};

export type RoadDisruption = {
  id: number;
  segmentId: number | null;
  title: string;
  type: string;
  severity: string;
  status: string; // active | resolved | expired
  description: string;
  lat: number;
  lng: number;
  geohash: string;
  geometry: [number, number][] | null;
  reportedBy: string;
  source: string;
  sourceKey: string;
  sourceName: string;
  sourceUrl: string | null;
  license: string;
  externalId: string | null;
  confidence: number;
  verification: string; // verified | community | unverified | rejected
  direction: string;
  rawText: string;
  extractedRoadName: string | null;
  matchedSegmentIds: number[];
  matchMethod: string;
  needsReview: boolean;
  eventStartsAt: Date | null;
  eventEndsAt: Date | null;
  lastFetchedAt: Date | null;
  startsAt: Date;
  endsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
};

export type RouteRow = {
  id: number;
  requestId: number | null;
  tripId: number | null;
  mode: string;
  origin: [number, number];
  destination: [number, number];
  geometry: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  alternatives: unknown;
  disruptions: unknown;
  trafficSummary: unknown;
  createdAt: Date;
};

export type Notification = {
  id: number;
  userId: number | null;
  role: string;
  requestId: number | null;
  type: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: Date;
};

export type DataSource = {
  id: number;
  key: string;
  name: string;
  category: string;
  url: string;
  license: string;
  coverage: string;
  updateFrequency: string;
  authentication: string;
  reliability: string;
  status: string;
  adapter: string;
  notes: string;
  lastRunAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  lastItemCount: number;
  createdAt: Date;
};

export type IngestionRun = {
  id: number;
  sourceKey: string;
  sourceName: string;
  status: string;
  itemsFetched: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsExpired: number;
  itemsFlagged: number;
  message: string;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
};

export type DisruptionReport = {
  id: number;
  sourceKey: string;
  sourceName: string;
  externalId: string | null;
  rawText: string;
  title: string;
  category: string;
  severity: string;
  confidence: number;
  roadName: string | null;
  lat: number | null;
  lng: number | null;
  matchedSegmentIds: number[];
  status: string; // pending | accepted | rejected
  reviewNote: string;
  disruptionId: number | null;
  createdAt: Date;
  reviewedAt: Date | null;
};

export type RerouteEvent = {
  id: number;
  requestId: number;
  tripId: number | null;
  routeId: number | null;
  triggerDisruptionId: number | null;
  reason: string;
  action: string; // recalculated | no_alternative | no_change
  oldEtaMinutes: number | null;
  newEtaMinutes: number | null;
  oldDistanceMeters: number | null;
  newDistanceMeters: number | null;
  createdAt: Date;
};

const now = () => new Date();

export const users = defineCollection<User>("users", { phone: "", role: "patient", createdAt: now });
export const sessions = defineCollection<Session>("sessions", { createdAt: now });
export const hospitals = defineCollection<Hospital>("hospitals", {
  district: "",
  phone: "",
  emergencyLevel: "Level II",
  traumaLevel: "",
  facilities: [],
  capabilities: [],
  verified: false,
  status: "active",
  geohash: "",
  createdAt: now,
});
export const drivers = defineCollection<Driver>("drivers", {
  phone: "",
  licenseNo: "",
  status: "offline",
  geohash: "",
  userId: null,
  lat: null,
  lng: null,
  ambulanceId: null,
  lastSeenAt: null,
  createdAt: now,
});
export const ambulances = defineCollection<Ambulance>("ambulances", {
  type: "BLS",
  status: "available",
  facilities: [],
  geohash: "",
  driverId: null,
  hospitalId: null,
  lastSeenAt: now,
  createdAt: now,
});
export const patients = defineCollection<Patient>("patients", { phone: "", address: "", geohash: "", createdAt: now });
export const emergencyRequests = defineCollection<EmergencyRequest>("emergency_requests", {
  patientPhone: "",
  severity: "serious",
  status: "pending",
  mode: "nearest",
  notes: "",
  channel: "app",
  pickupAddress: "",
  etaMinutes: null,
  distanceKm: null,
  preferredHospitalId: null,
  hospitalId: null,
  ambulanceId: null,
  driverId: null,
  patientId: null,
  completedAt: null,
  createdAt: now,
  updatedAt: now,
});
export const ambulanceAssignments = defineCollection<AmbulanceAssignment>("ambulance_assignments", {
  status: "pending",
  reason: "",
  driverId: null,
  respondedAt: null,
  createdAt: now,
});
export const trips = defineCollection<Trip>("trips", {
  status: "to_pickup",
  distanceKm: 0,
  durationSeconds: 0,
  acceptedAt: null,
  arrivedPickupAt: null,
  pickedUpAt: null,
  arrivedHospitalAt: null,
  completedAt: null,
  startedAt: now,
});
export const roadSegments = defineCollection<RoadSegment>("road_segments", {
  district: "",
  trafficLevel: "moderate",
  status: "open",
  severity: 0,
  createdAt: now,
});
export const roadDisruptions = defineCollection<RoadDisruption>("road_disruptions", {
  severity: "moderate",
  status: "active",
  description: "",
  geohash: "",
  geometry: null,
  reportedBy: "field_unit",
  source: "demo",
  sourceKey: "demo_seed",
  sourceName: "Demonstration dataset",
  sourceUrl: null,
  license: "Demo data",
  externalId: null,
  confidence: 1,
  verification: "verified",
  direction: "both",
  rawText: "",
  extractedRoadName: null,
  matchedSegmentIds: [],
  matchMethod: "manual",
  needsReview: false,
  eventStartsAt: now,
  eventEndsAt: null,
  lastFetchedAt: now,
  startsAt: now,
  endsAt: null,
  createdAt: now,
  updatedAt: now,
  resolvedAt: null,
});
export const routes = defineCollection<RouteRow>("routes", {
  mode: "nearest",
  requestId: null,
  tripId: null,
  alternatives: [],
  disruptions: [],
  trafficSummary: {},
  createdAt: now,
});
export const notifications = defineCollection<Notification>("notifications", {
  role: "driver",
  type: "info",
  body: "",
  read: false,
  userId: null,
  requestId: null,
  createdAt: now,
});
export const dataSources = defineCollection<DataSource>("data_sources", {
  url: "",
  license: "",
  coverage: "",
  updateFrequency: "",
  authentication: "none",
  reliability: "medium",
  status: "planned",
  adapter: "none",
  notes: "",
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  lastItemCount: 0,
  createdAt: now,
});
export const ingestionRuns = defineCollection<IngestionRun>("ingestion_runs", {
  status: "success",
  itemsFetched: 0,
  itemsCreated: 0,
  itemsUpdated: 0,
  itemsExpired: 0,
  itemsFlagged: 0,
  message: "",
  error: null,
  startedAt: now,
  finishedAt: null,
});
export const disruptionReports = defineCollection<DisruptionReport>("disruption_reports", {
  status: "pending",
  reviewNote: "",
  externalId: null,
  roadName: null,
  lat: null,
  lng: null,
  matchedSegmentIds: [],
  disruptionId: null,
  reviewedAt: null,
  createdAt: now,
});
export const rerouteEvents = defineCollection<RerouteEvent>("reroute_events", {
  tripId: null,
  routeId: null,
  triggerDisruptionId: null,
  oldEtaMinutes: null,
  newEtaMinutes: null,
  oldDistanceMeters: null,
  newDistanceMeters: null,
  createdAt: now,
});
