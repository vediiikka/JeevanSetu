export type LatLng = { lat: number; lng: number };
export type Coord = [number, number]; // [lng, lat] GeoJSON order

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from north. */
export function bearing(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Project a point onto a polyline, returning the closest point + distance along the line. */
export function projectOnPolyline(
  point: LatLng,
  line: LatLng[],
): { point: LatLng; distanceMeters: number; alongMeters: number; index: number } {
  let best = { point: line[0] ?? point, distanceMeters: Number.POSITIVE_INFINITY, alongMeters: 0, index: 0 };
  let accumulated = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    const segLen = haversine(a, b);
    if (segLen === 0) continue;
    // Local equirectangular projection for accurate projection maths.
    const latRef = toRad((a.lat + b.lat) / 2);
    const kx = Math.cos(latRef) * EARTH_RADIUS_M;
    const ky = EARTH_RADIUS_M;
    const px = (point.lng - a.lng) * kx;
    const py = (point.lat - a.lat) * ky;
    const bx = (b.lng - a.lng) * kx;
    const by = (b.lat - a.lat) * ky;
    const lenSq = bx * bx + by * by;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / lenSq));
    const projLat = a.lat + (b.lat - a.lat) * t;
    const projLng = a.lng + (b.lng - a.lng) * t;
    const distanceMeters = haversine(point, { lat: projLat, lng: projLng });
    if (distanceMeters < best.distanceMeters) {
      best = {
        point: { lat: projLat, lng: projLng },
        distanceMeters,
        alongMeters: accumulated + segLen * t,
        index: i,
      };
    }
    accumulated += segLen;
  }
  return best;
}

/** Point at a given distance along a polyline. */
export function pointAlongPolyline(line: LatLng[], targetMeters: number): LatLng {
  if (line.length === 0) return { lat: 0, lng: 0 };
  if (line.length === 1) return line[0];
  let accumulated = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const segLen = haversine(line[i], line[i + 1]);
    if (accumulated + segLen >= targetMeters) {
      const t = segLen === 0 ? 0 : (targetMeters - accumulated) / segLen;
      return {
        lat: line[i].lat + (line[i + 1].lat - line[i].lat) * t,
        lng: line[i].lng + (line[i + 1].lng - line[i].lng) * t,
      };
    }
    accumulated += segLen;
  }
  return line[line.length - 1];
}

/** Slice a polyline between two distances (metres). */
export function slicePolyline(line: LatLng[], fromMeters: number, toMeters: number): LatLng[] {
  const out: LatLng[] = [];
  const start = pointAlongPolyline(line, fromMeters);
  out.push(start);
  let accumulated = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const segLen = haversine(line[i], line[i + 1]);
    const next = accumulated + segLen;
    if (next > fromMeters && next < toMeters) out.push(line[i + 1]);
    accumulated = next;
  }
  out.push(pointAlongPolyline(line, toMeters));
  return out;
}

/** Total length of a polyline in metres. */
export function polylineLength(line: LatLng[]): number {
  let total = 0;
  for (let i = 0; i < line.length - 1; i += 1) total += haversine(line[i], line[i + 1]);
  return total;
}

const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Compact geohash (used as a relational stand-in for a 2dsphere prefix index). */
export function geohash(lat: number, lng: number, precision = 7): string {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let hash = "";
  let bit = 0;
  let ch = 0;
  let even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng > mid) {
        ch = (ch << 1) + 1;
        lngMin = mid;
      } else {
        ch = ch << 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat > mid) {
        ch = (ch << 1) + 1;
        latMin = mid;
      } else {
        ch = ch << 1;
        latMax = mid;
      }
    }
    even = !even;
    if (++bit === 5) {
      hash += GEOHASH_BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

/** Bounding box (degrees) around a point, used for cheap proximity pre-filtering. */
export function bboxAround(point: LatLng, radiusMeters: number) {
  const latDelta = radiusMeters / 111_320;
  const lngDelta = radiusMeters / (111_320 * Math.max(0.15, Math.cos(toRad(point.lat))));
  return {
    minLat: point.lat - latDelta,
    maxLat: point.lat + latDelta,
    minLng: point.lng - lngDelta,
    maxLng: point.lng + lngDelta,
  };
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return "—";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return `${hours} h ${mins % 60} min`;
}

export function formatEta(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "—";
  if (minutes <= 0) return "Arriving";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function toCoord(p: LatLng): Coord {
  return [Number(p.lng.toFixed(6)), Number(p.lat.toFixed(6))];
}

export function fromCoord(c: Coord): LatLng {
  return { lat: c[1], lng: c[0] };
}
