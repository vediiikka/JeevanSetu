/**
 * Driver profile and driver list types, shared by the server (dispatch / driverProfile) and the
 * admin screens. Pure types: safe to import from client and server code.
 */

export type ProfileTimelineEntry = { key: string; label: string; at: string | null };

/** One row in the admin driver list (every registered driver). */
export type DriverListItem = {
  id: number;
  name: string;
  phone: string;
  licenseNo: string;
  status: string; // online | offline | on_trip
  loginEmail: string | null;
  ambulanceId: number | null;
  ambulanceCode: string | null;
  /** Last GPS report from the driver's device (may be a desk location, shown as such). */
  deviceLat: number | null;
  deviceLng: number | null;
  deviceUpdatedSecondsAgo: number | null;
  /** Live stage of the driver's ambulance: available | to_patient | to_hospital | at_hospital | assigned | idle | offline. */
  stage: string;
  stageLabel: string;
  requestPublicId: string | null;
};

export type DriverProfile = {
  generatedAt: string;
  driver: {
    id: number;
    name: string;
    phone: string;
    licenseNo: string;
    status: string;
    createdAt: string;
    lastSeenAt: string | null;
  };
  login: {
    email: string | null;
    username: string | null;
    role: string | null;
  };
  vehicle: {
    id: number;
    code: string;
    type: string;
    status: string;
    facilities: string[];
    base: { id: number; name: string; lat: number; lng: number } | null;
  } | null;
  position: {
    /** Ambulance position used by dispatch and the map. */
    ambulance: { lat: number; lng: number; source: string; updatedSecondsAgo: number | null } | null;
    /** Last GPS report from the driver's device. */
    device: { lat: number; lng: number; updatedSecondsAgo: number | null } | null;
  };
  live: {
    stage: string;
    stageLabel: string;
    speedKph: number;
    progress: number;
    remainingMeters: number;
    remainingSeconds: number;
    nextStop: { kind: "patient" | "hospital"; name: string; lat: number; lng: number } | null;
    route: {
      purpose: "pickup" | "hospital";
      optionKey: string | null;
      optionLabel: string | null;
      algorithm: string | null;
      engine: string;
      distanceMeters: number;
      durationSeconds: number;
      trafficMix: { green: number; orange: number; red: number } | null;
      chosenAt: string | null;
    } | null;
  };
  currentTrip: {
    requestId: number;
    publicId: string;
    status: string;
    category: string;
    severity: string;
    startedAt: string | null;
    patient: { name: string; phone: string };
    pickup: { lat: number; lng: number; address: string };
    hospital: { id: number; name: string; address: string; phone: string; lat: number; lng: number } | null;
    etaMinutes: number | null;
    distanceKm: number | null;
    timeline: ProfileTimelineEntry[];
  } | null;
  assignments: {
    id: number;
    requestId: number;
    publicId: string;
    status: string;
    reason: string;
    createdAt: string;
    respondedAt: string | null;
  }[];
  trips: {
    id: number;
    requestId: number;
    publicId: string;
    patientName: string;
    category: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    distanceKm: number;
    durationSeconds: number;
  }[];
  stats: {
    completedTrips: number;
    activeTrips: number;
    totalDistanceKm: number;
    pickups: number;
    assignmentsAccepted: number;
    assignmentsRejected: number;
  };
};
