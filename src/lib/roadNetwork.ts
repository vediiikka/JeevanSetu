import { haversine, type LatLng } from "@/lib/geo";

export type RoadClass = "highway" | "arterial" | "collector" | "local";

export type Corridor = {
  roadName: string;
  city: string;
  district: string;
  roadClass: RoadClass;
  points: [number, number][]; // [lat, lng]
};

export const ROAD_CLASS_SPEED: Record<RoadClass, number> = {
  highway: 80,
  arterial: 45,
  collector: 35,
  local: 25,
};

/**
 * Demonstration road network for the initial Gujarat coverage area.
 * Coordinates are approximate real-world alignments of major corridors
 * (NH-48 / NE-1 expressway / city ring roads) and are labelled as demo data in
 * the UI. Each polyline is split into routable segments between junctions.
 */
export const CORRIDORS: Corridor[] = [
  // ---------------- Ahmedabad ----------------
  {
    roadName: "SG Highway (Ahmedabad)",
    city: "Ahmedabad",
    district: "Ahmedabad",
    roadClass: "highway",
    points: [
      [23.15, 72.5],
      [23.115, 72.51],
      [23.08, 72.515],
      [23.045, 72.52],
      [23.01, 72.525],
      [22.975, 72.53],
      [22.94, 72.535],
    ],
  },
  {
    roadName: "Ashram Road",
    city: "Ahmedabad",
    district: "Ahmedabad",
    roadClass: "arterial",
    points: [
      [23.045, 72.59],
      [23.03, 72.582],
      [23.015, 72.575],
      [23.0, 72.568],
      [22.985, 72.56],
      [22.97, 72.552],
    ],
  },
  {
    roadName: "S P Ring Road",
    city: "Ahmedabad",
    district: "Ahmedabad",
    roadClass: "arterial",
    points: [
      [23.09, 72.49],
      [23.09, 72.52],
      [23.09, 72.55],
      [23.09, 72.58],
      [23.09, 72.61],
    ],
  },
  {
    roadName: "132 Feet Ring Road",
    city: "Ahmedabad",
    district: "Ahmedabad",
    roadClass: "arterial",
    points: [
      [22.98, 72.49],
      [22.98, 72.52],
      [22.98, 72.55],
      [22.98, 72.58],
      [22.98, 72.61],
    ],
  },
  {
    roadName: "Ring Road (Central)",
    city: "Ahmedabad",
    district: "Ahmedabad",
    roadClass: "arterial",
    points: [
      [23.04, 72.5],
      [23.04, 72.53],
      [23.04, 72.56],
      [23.04, 72.59],
      [23.04, 72.62],
    ],
  },
  {
    roadName: "Navrangpura – Maninagar Road",
    city: "Ahmedabad",
    district: "Ahmedabad",
    roadClass: "collector",
    points: [
      [23.03, 72.55],
      [23.015, 72.565],
      [23.0, 72.58],
      [22.985, 72.595],
    ],
  },
  {
    roadName: "Ahmedabad – Gandhinagar Highway",
    city: "Ahmedabad",
    district: "Ahmedabad",
    roadClass: "highway",
    points: [
      [23.045, 72.52],
      [23.08, 72.545],
      [23.12, 72.57],
      [23.16, 72.595],
      [23.2, 72.62],
      [23.2156, 72.6369],
    ],
  },
  {
    roadName: "Ahmedabad – Vadodara Expressway (NE-1)",
    city: "Ahmedabad",
    district: "Ahmedabad",
    roadClass: "highway",
    points: [
      [23.01, 72.525],
      [22.97, 72.56],
      [22.92, 72.61],
      [22.87, 72.66],
      [22.82, 72.71],
      [22.77, 72.76],
      [22.72, 72.82],
      [22.67, 72.88],
      [22.62, 72.94],
      [22.57, 73.0],
      [22.52, 73.06],
      [22.47, 73.11],
      [22.42, 73.15],
      [22.37, 73.17],
      [22.3072, 73.1812],
    ],
  },
  {
    roadName: "Ahmedabad – Rajkot Highway (NH-27)",
    city: "Ahmedabad",
    district: "Ahmedabad",
    roadClass: "highway",
    points: [
      [22.98, 72.55],
      [22.9, 72.46],
      [22.82, 72.38],
      [22.74, 72.3],
      [22.66, 72.22],
      [22.58, 72.12],
      [22.5, 72.02],
      [22.44, 71.9],
      [22.38, 71.78],
      [22.32, 71.66],
      [22.26, 71.54],
      [22.2, 71.42],
      [22.14, 71.3],
      [22.1, 71.2],
      [22.12, 71.1],
      [22.18, 71.0],
      [22.24, 70.9],
      [22.3039, 70.8022],
    ],
  },
  {
    roadName: "Ahmedabad East Connector",
    city: "Ahmedabad",
    district: "Ahmedabad",
    roadClass: "collector",
    points: [
      [23.04, 72.56],
      [23.06, 72.575],
      [23.08, 72.59],
      [23.09, 72.61],
    ],
  },
  {
    roadName: "Ahmedabad South Connector",
    city: "Ahmedabad",
    district: "Ahmedabad",
    roadClass: "collector",
    points: [
      [22.98, 72.55],
      [22.99, 72.57],
      [23.0, 72.59],
      [23.01, 72.61],
    ],
  },
  // ---------------- Gandhinagar ----------------
  {
    roadName: "Gandhinagar Main Road",
    city: "Gandhinagar",
    district: "Gandhinagar",
    roadClass: "arterial",
    points: [
      [23.2156, 72.6],
      [23.2156, 72.62],
      [23.2156, 72.6369],
      [23.2156, 72.66],
      [23.2156, 72.68],
    ],
  },
  {
    roadName: "Gandhinagar North – South Road",
    city: "Gandhinagar",
    district: "Gandhinagar",
    roadClass: "collector",
    points: [
      [23.25, 72.6369],
      [23.23, 72.6369],
      [23.2156, 72.6369],
      [23.2, 72.6369],
      [23.18, 72.6369],
    ],
  },
  {
    roadName: "Gandhinagar – Ahmedabad Link Road",
    city: "Gandhinagar",
    district: "Gandhinagar",
    roadClass: "arterial",
    points: [
      [23.2156, 72.6369],
      [23.18, 72.61],
      [23.14, 72.58],
      [23.1, 72.55],
      [23.07, 72.53],
      [23.045, 72.52],
    ],
  },
  // ---------------- Vadodara ----------------
  {
    roadName: "Vadodara Ring Road",
    city: "Vadodara",
    district: "Vadodara",
    roadClass: "arterial",
    points: [
      [22.3072, 73.14],
      [22.3072, 73.16],
      [22.3072, 73.1812],
      [22.3072, 73.2],
      [22.3072, 73.22],
    ],
  },
  {
    roadName: "Vadodara North – South Road",
    city: "Vadodara",
    district: "Vadodara",
    roadClass: "arterial",
    points: [
      [22.35, 73.1812],
      [22.33, 73.1812],
      [22.3072, 73.1812],
      [22.28, 73.18],
      [22.25, 73.18],
    ],
  },
  {
    roadName: "Vadodara – Halol Road",
    city: "Vadodara",
    district: "Vadodara",
    roadClass: "collector",
    points: [
      [22.3072, 73.1812],
      [22.25, 73.2],
      [22.2, 73.22],
      [22.15, 73.24],
    ],
  },
  {
    roadName: "Vadodara – Anand Road",
    city: "Vadodara",
    district: "Vadodara",
    roadClass: "collector",
    points: [
      [22.3072, 73.1812],
      [22.35, 73.16],
      [22.4, 73.14],
      [22.45, 73.12],
    ],
  },
  {
    roadName: "Vadodara – Surat Expressway (NH-48)",
    city: "Vadodara",
    district: "Vadodara",
    roadClass: "highway",
    points: [
      [22.3072, 73.1812],
      [22.25, 73.15],
      [22.15, 73.1],
      [22.05, 73.05],
      [21.95, 73.0],
      [21.85, 72.95],
      [21.75, 72.9],
      [21.65, 72.87],
      [21.55, 72.85],
      [21.45, 72.84],
      [21.35, 72.835],
      [21.25, 72.83],
      [21.1702, 72.8311],
    ],
  },
  // ---------------- Surat ----------------
  {
    roadName: "Surat Ring Road",
    city: "Surat",
    district: "Surat",
    roadClass: "arterial",
    points: [
      [21.1702, 72.78],
      [21.1702, 72.8],
      [21.1702, 72.8311],
      [21.1702, 72.86],
      [21.1702, 72.88],
    ],
  },
  {
    roadName: "Surat North – South Road",
    city: "Surat",
    district: "Surat",
    roadClass: "arterial",
    points: [
      [21.22, 72.8311],
      [21.2, 72.8311],
      [21.1702, 72.8311],
      [21.14, 72.83],
      [21.1, 72.825],
    ],
  },
  {
    roadName: "Surat – Navsari Road",
    city: "Surat",
    district: "Surat",
    roadClass: "collector",
    points: [
      [21.1702, 72.8311],
      [21.12, 72.82],
      [21.07, 72.81],
      [21.02, 72.8],
    ],
  },
  {
    roadName: "Surat – Bardoli Road",
    city: "Surat",
    district: "Surat",
    roadClass: "collector",
    points: [
      [21.1702, 72.8311],
      [21.15, 72.88],
      [21.13, 72.92],
      [21.11, 72.96],
    ],
  },
  // ---------------- Rajkot ----------------
  {
    roadName: "Rajkot Ring Road",
    city: "Rajkot",
    district: "Rajkot",
    roadClass: "arterial",
    points: [
      [22.3039, 70.76],
      [22.3039, 70.78],
      [22.3039, 70.8022],
      [22.3039, 70.83],
      [22.3039, 70.85],
    ],
  },
  {
    roadName: "Rajkot North – South Road",
    city: "Rajkot",
    district: "Rajkot",
    roadClass: "arterial",
    points: [
      [22.34, 70.8022],
      [22.32, 70.8022],
      [22.3039, 70.8022],
      [22.28, 70.8],
      [22.25, 70.8],
    ],
  },
  {
    roadName: "Rajkot – Kotda Sangani Road",
    city: "Rajkot",
    district: "Rajkot",
    roadClass: "collector",
    points: [
      [22.3039, 70.8022],
      [22.35, 70.78],
      [22.4, 70.76],
    ],
  },
  {
    roadName: "Rajkot – Jasdan Road",
    city: "Rajkot",
    district: "Rajkot",
    roadClass: "collector",
    points: [
      [22.3039, 70.8022],
      [22.25, 70.83],
      [22.2, 70.86],
    ],
  },
];

type Point = { lat: number; lng: number };

type SplitMark = { segmentIndex: number; t: number; point: Point };

/** Segment–segment intersection in lat/lng space. Returns parametric positions. */
function segmentIntersection(a1: Point, a2: Point, b1: Point, b2: Point): { t: number; u: number; point: Point } | null {
  const rX = a2.lng - a1.lng;
  const rY = a2.lat - a1.lat;
  const sX = b2.lng - b1.lng;
  const sY = b2.lat - b1.lat;
  const denom = rX * sY - rY * sX;
  if (Math.abs(denom) < 1e-12) return null;
  const qpX = b1.lng - a1.lng;
  const qpY = b1.lat - a1.lat;
  const t = (qpX * sY - qpY * sX) / denom;
  const u = (qpX * rY - qpY * rX) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, point: { lat: a1.lat + t * rY, lng: a1.lng + t * rX } };
}

/**
 * Insert real junction vertices wherever two corridors cross. Without this the
 * sparse polylines would leave disconnected components in the graph.
 */
export function splitCorridorsAtIntersections(corridors: Corridor[]): Corridor[] {
  const points: Point[][] = corridors.map((c) => c.points.map(([lat, lng]) => ({ lat, lng })));
  const marks: SplitMark[][] = corridors.map(() => []);

  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      for (let a = 0; a < points[i].length - 1; a += 1) {
        for (let b = 0; b < points[j].length - 1; b += 1) {
          const hit = segmentIntersection(points[i][a], points[i][a + 1], points[j][b], points[j][b + 1]);
          if (!hit) continue;
          marks[i].push({ segmentIndex: a, t: hit.t, point: hit.point });
          marks[j].push({ segmentIndex: b, t: hit.u, point: hit.point });
        }
      }
    }
  }

  return corridors.map((corridor, index) => {
    const original = points[index];
    const corridorMarks = marks[index]
      .filter((mark) => mark.t > 0.001 && mark.t < 0.999)
      .sort((a, b) => a.segmentIndex - b.segmentIndex || a.t - b.t);
    if (corridorMarks.length === 0) return corridor;
    const rebuilt: Point[] = [original[0]];
    let cursor = 0;
    for (const mark of corridorMarks) {
      while (cursor < mark.segmentIndex) {
        cursor += 1;
        rebuilt.push(original[cursor]);
      }
      const last = rebuilt[rebuilt.length - 1];
      if (haversine(last, mark.point) > 8) rebuilt.push(mark.point);
    }
    rebuilt.push(original[original.length - 1]);
    return { ...corridor, points: rebuilt.map((p) => [p.lat, p.lng] as [number, number]) };
  });
}

export const SPLIT_CORRIDORS = splitCorridorsAtIntersections(CORRIDORS);

export type NetworkNode = { id: string; lat: number; lng: number };

export type NetworkEdge = {
  id: string;
  code: string;
  roadName: string;
  city: string;
  district: string;
  roadClass: RoadClass;
  from: string;
  to: string;
  geometry: [number, number][];
  distanceMeters: number;
  baseSpeedKph: number;
};

const SNAP_TOLERANCE_M = 140;

/** Build a routable graph by clustering corridor vertices into junctions. */
export function buildRoadNetwork(corridors: Corridor[] = CORRIDORS): {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
} {
  const nodes: NetworkNode[] = [];
  const grid = new Map<string, number[]>();

  const keyFor = (lat: number, lng: number) =>
    `${Math.round(lat / (SNAP_TOLERANCE_M / 111_320))}:${Math.round(lng / (SNAP_TOLERANCE_M / 111_320))}`;

  const findNode = (p: LatLng): string => {
    const baseLat = Math.round(p.lat / (SNAP_TOLERANCE_M / 111_320));
    const baseLng = Math.round(p.lng / (SNAP_TOLERANCE_M / 111_320));
    for (let dLat = -1; dLat <= 1; dLat += 1) {
      for (let dLng = -1; dLng <= 1; dLng += 1) {
        const bucket = grid.get(`${baseLat + dLat}:${baseLng + dLng}`);
        if (!bucket) continue;
        for (const idx of bucket) {
          if (haversine(nodes[idx], p) <= SNAP_TOLERANCE_M) return nodes[idx].id;
        }
      }
    }
    const id = `n${nodes.length + 1}`;
    nodes.push({ id, lat: p.lat, lng: p.lng });
    const key = keyFor(p.lat, p.lng);
    const bucket = grid.get(key) ?? [];
    bucket.push(nodes.length - 1);
    grid.set(key, bucket);
    return id;
  };

  const edgeMap = new Map<string, NetworkEdge>();
  let counter = 0;

  for (const corridor of corridors) {
    const ids = corridor.points.map(([lat, lng]) => findNode({ lat, lng }));
    for (let i = 0; i < ids.length - 1; i += 1) {
      const from = ids[i];
      const to = ids[i + 1];
      if (from === to) continue;
      const a = nodes.find((n) => n.id === from)!;
      const b = nodes.find((n) => n.id === to)!;
      const distanceMeters = haversine(a, b);
      if (distanceMeters < 30) continue;
      const pairKey = [from, to].sort().join("|");
      const existing = edgeMap.get(pairKey);
      const speed = ROAD_CLASS_SPEED[corridor.roadClass];
      if (existing) {
        // Keep the higher-class carriageway when corridors overlap.
        if (speed > existing.baseSpeedKph) {
          existing.roadClass = corridor.roadClass;
          existing.baseSpeedKph = speed;
          existing.roadName = corridor.roadName;
          existing.city = corridor.city;
          existing.district = corridor.district;
        }
        continue;
      }
      counter += 1;
      edgeMap.set(pairKey, {
        id: `e${counter}`,
        code: `GJ-${corridor.city.slice(0, 3).toUpperCase()}-${String(counter).padStart(4, "0")}`,
        roadName: corridor.roadName,
        city: corridor.city,
        district: corridor.district,
        roadClass: corridor.roadClass,
        from,
        to,
        geometry: [
          [Number(a.lng.toFixed(6)), Number(a.lat.toFixed(6))],
          [Number(b.lng.toFixed(6)), Number(b.lat.toFixed(6))],
        ],
        distanceMeters: Math.round(distanceMeters),
        baseSpeedKph: speed,
      });
    }
  }

  return { nodes, edges: [...edgeMap.values()] };
}

export const NETWORK = buildRoadNetwork(SPLIT_CORRIDORS);

export const CITY_CENTERS: Record<string, LatLng> = {
  Ahmedabad: { lat: 23.0225, lng: 72.5714 },
  Gandhinagar: { lat: 23.2156, lng: 72.6369 },
  Vadodara: { lat: 22.3072, lng: 73.1812 },
  Surat: { lat: 21.1702, lng: 72.8311 },
  Rajkot: { lat: 22.3039, lng: 70.8022 },
};

export const GUJARAT_BOUNDS = { minLat: 22.0, maxLat: 23.3, minLng: 70.7, maxLng: 73.3 };
