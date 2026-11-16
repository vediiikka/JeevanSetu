#!/usr/bin/env node
/**
 * Builds the JeevanSetu road network from OpenStreetMap (Overpass API) and writes it to
 * data/road-graph/gujarat-osm.json.gz. The app loads this file at start-up, so routing does
 * not depend on any external service while the server runs.
 *
 * Data: © OpenStreetMap contributors, licensed under the Open Database License (ODbL 1.0).
 * Attribution is shown in the application.
 *
 * Usage:  node scripts/build-road-graph.mjs
 */
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../data/road-graph/gujarat-osm.json.gz");

// Coverage: Ahmedabad, Gandhinagar and the corridor between them (south, west, north, east).
const BBOX = { south: 22.97, west: 72.48, north: 23.28, east: 72.72 };
const TILES = 3; // split into TILES x TILES queries to keep each request small

const ENDPOINTS = [
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];
const HIGHWAY =
  "motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link";
const USER_AGENT = "JeevanSetu/1.0 (emergency routing; contact admin@jeevansetu.in)";

function tileBoxes() {
  const boxes = [];
  const latStep = (BBOX.north - BBOX.south) / TILES;
  const lngStep = (BBOX.east - BBOX.west) / TILES;
  for (let i = 0; i < TILES; i += 1) {
    for (let j = 0; j < TILES; j += 1) {
      boxes.push({
        south: BBOX.south + i * latStep,
        north: BBOX.south + (i + 1) * latStep,
        west: BBOX.west + j * lngStep,
        east: BBOX.west + (j + 1) * lngStep,
      });
    }
  }
  return boxes;
}

async function queryTile(box) {
  const bbox = `${box.south.toFixed(5)},${box.west.toFixed(5)},${box.north.toFixed(5)},${box.east.toFixed(5)}`;
  const query = `[out:json][timeout:180];way["highway"~"^(${HIGHWAY})$"](${bbox});out tags geom;`;
  let lastError = "no endpoint answered";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    for (const endpoint of ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
            Accept: "application/json",
          },
          body: new URLSearchParams({ data: query }).toString(),
          signal: AbortSignal.timeout(240_000),
        });
        if (!response.ok) {
          lastError = `${endpoint} HTTP ${response.status}`;
          continue;
        }
        const payload = await response.json();
        if (!Array.isArray(payload.elements)) throw new Error("no elements in response");
        return payload.elements;
      } catch (error) {
        lastError = `${endpoint}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    await new Promise((r) => setTimeout(r, 4000 * attempt));
  }
  throw new Error(`tile ${bbox} failed: ${lastError}`);
}

const CLASS_LIST = [
  "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
  "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
];

function parseMaxspeed(value) {
  if (!value) return null;
  const match = /^(\d{2,3})/.exec(value);
  return match ? Number(match[1]) : null;
}

const key = (lng, lat) => `${lng.toFixed(6)},${lat.toFixed(6)}`;

console.log("Querying OpenStreetMap via Overpass …");
const ways = new Map(); // way id -> element
for (const box of tileBoxes()) {
  const elements = await queryTile(box);
  for (const element of elements) {
    if (element.type === "way" && Array.isArray(element.geometry) && element.geometry.length >= 2) {
      ways.set(element.id, element);
    }
  }
  console.log(`  tile ${box.south.toFixed(3)},${box.west.toFixed(3)} → ${elements.length} ways (unique so far ${ways.size})`);
  await new Promise((r) => setTimeout(r, 1500));
}

// Junctions: coordinates that are a way end or shared by two or more ways. Interior points
// of a single way are kept as geometry only, so the graph stays compact but follows every bend.
const usage = new Map();
for (const way of ways.values()) {
  const seen = new Set();
  for (const point of way.geometry) {
    const k = key(point.lon, point.lat);
    if (seen.has(k)) continue;
    seen.add(k);
    usage.set(k, (usage.get(k) ?? 0) + 1);
  }
}
const nodeIndex = new Map();
const nodes = [];
const nodeOf = (lng, lat) => {
  const k = key(lng, lat);
  let index = nodeIndex.get(k);
  if (index === undefined) {
    index = nodes.length;
    nodeIndex.set(k, index);
    nodes.push([Number(lng.toFixed(6)), Number(lat.toFixed(6))]);
  }
  return index;
};

const names = [];
const nameIndex = new Map();
const nameOf = (name) => {
  if (!name) return -1;
  let index = nameIndex.get(name);
  if (index === undefined) {
    index = names.length;
    names.push(name);
    nameIndex.set(name, index);
  }
  return index;
};

const edges = []; // [a, b, lengthMeters, classIndex, oneway(0|1|-1), nameIndex, maxspeed|0, geometry flat (interior)]
const classIndex = new Map(CLASS_LIST.map((c, i) => [c, i]));
const toRad = (d) => (d * Math.PI) / 180;
const haversine = (a, b) => {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
};

for (const way of ways.values()) {
  const tags = way.tags ?? {};
  const cls = classIndex.get(tags.highway);
  if (cls === undefined) continue;
  const oneway = tags.oneway === "yes" || tags.junction === "roundabout" ? 1 : tags.oneway === "-1" ? -1 : 0;
  const maxspeed = parseMaxspeed(tags.maxspeed) ?? 0;
  const nameId = nameOf(tags.name ?? tags.ref ?? "");

  // Split the way at junction coordinates.
  const pts = way.geometry.map((p) => [p.lon, p.lat]);
  let segmentStart = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const isJunction = usage.get(key(pts[i][0], pts[i][1])) >= 2 || i === pts.length - 1;
    if (!isJunction) continue;
    const from = pts.slice(segmentStart, i + 1);
    if (from.length >= 2) {
      let length = 0;
      for (let k = 1; k < from.length; k += 1) length += haversine(from[k - 1], from[k]);
      if (length >= 1) {
        const interior = [];
        for (let k = 1; k < from.length - 1; k += 1) {
          interior.push(Number(from[k][0].toFixed(6)), Number(from[k][1].toFixed(6)));
        }
        edges.push([
          nodeOf(from[0][0], from[0][1]),
          nodeOf(from[from.length - 1][0], from[from.length - 1][1]),
          Math.round(length),
          cls,
          oneway,
          nameId,
          maxspeed,
          interior,
        ]);
      }
    }
    segmentStart = i;
  }
}

const graph = {
  format: "jeevansetu-road-graph/1",
  generatedAt: new Date().toISOString(),
  source: "OpenStreetMap contributors via Overpass API",
  license: "ODbL 1.0 — © OpenStreetMap contributors (https://www.openstreetmap.org/copyright)",
  bbox: BBOX,
  classes: CLASS_LIST,
  names,
  nodes,
  edges,
};

mkdirSync(dirname(OUT), { recursive: true });
const gz = gzipSync(Buffer.from(JSON.stringify(graph)), { level: 9 });
writeFileSync(OUT, gz);
console.log(
  `Wrote ${OUT}\n  junctions: ${nodes.length}\n  road segments: ${edges.length}\n  named roads: ${names.length}\n  size: ${(gz.length / 1048576).toFixed(2)} MB (gzip)`,
);
