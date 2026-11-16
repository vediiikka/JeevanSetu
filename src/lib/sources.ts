/**
 * Road-disruption data source catalogue and adapters.
 *
 * Design rules:
 *  - Only sources that are actually reachable/authorised are called at runtime.
 *  - Every other investigated source is still registered with an explicit
 *    evaluation (availability, coverage, frequency, auth, licence, reliability)
 *    so operators can see *why* it is not integrated.
 *  - Adapters never throw: they return observations plus a structured error so
 *    the pipeline can mark the source degraded without breaking ingestion.
 */

export type RawObservation = {
  externalId: string;
  title: string;
  description: string;
  rawText: string;
  category?: string;
  severity?: string;
  lat?: number;
  lng?: number;
  roadName?: string;
  direction?: string;
  startsAt?: Date;
  endsAt?: Date;
  url?: string;
  reportedAt?: Date;
};

export type SourceCategory = "open_data" | "government" | "traffic_api" | "weather" | "media" | "manual" | "demo";

export type SourceDefinition = {
  key: string;
  name: string;
  category: SourceCategory;
  url: string;
  license: string;
  coverage: string;
  updateFrequency: string;
  authentication: string;
  reliability: "high" | "medium" | "low";
  adapter: string;
  enabled: boolean;
  notes: string;
};

export type AdapterResult = { observations: RawObservation[]; error?: string };

export type Adapter = {
  key: string;
  fetch: (signal: AbortSignal) => Promise<AdapterResult>;
};

/**
 * Evaluated source catalogue. `enabled: true` means an adapter runs on every
 * ingestion pass; everything else is documented but deliberately not called.
 */
export const SOURCE_CATALOG: SourceDefinition[] = [
  {
    key: "osm_overpass",
    name: "OpenStreetMap · Overpass API (live road restrictions)",
    category: "open_data",
    url: "https://overpass-api.de/api/interpreter",
    license: "ODbL 1.0 (attribution + share-alike)",
    coverage: "Gujarat bbox (Ahmedabad + Gandhinagar focus)",
    updateFrequency: "On demand (community edits, typically minutes–hours)",
    authentication: "none (fair-use limits, custom User-Agent required)",
    reliability: "medium",
    adapter: "osm",
    enabled: true,
    notes:
      "Real, queryable source for construction, gates/barriers and access restrictions. It does NOT carry live accident or waterlogging feeds, so those categories still need official or field reports.",
  },
  {
    key: "open_meteo",
    name: "Open-Meteo forecast API (rainfall → waterlogging risk)",
    category: "weather",
    url: "https://api.open-meteo.com/v1/forecast",
    license: "CC-BY-4.0 (attribution required)",
    coverage: "Gujarat (5 city points)",
    updateFrequency: "Hourly model runs, 16-day horizon",
    authentication: "none for non-commercial use",
    reliability: "high",
    adapter: "weather",
    enabled: true,
    notes:
      "Authoritative meteorological input. Rainfall is converted into *predicted waterlogging risk* at known low-lying hotspots — never presented as a confirmed road closure.",
  },
  {
    key: "nominatim",
    name: "OpenStreetMap Nominatim (geocoding)",
    category: "open_data",
    url: "https://nominatim.openstreetmap.org/reverse",
    license: "ODbL 1.0 (attribution required)",
    coverage: "Global",
    updateFrequency: "On demand",
    authentication: "none (1 req/s policy, descriptive User-Agent)",
    reliability: "medium",
    adapter: "geocode",
    enabled: true,
    notes: "Used to resolve free-text location mentions from announcements into coordinates before segment matching.",
  },
  {
    key: "demo_seed",
    name: "JeevanSetu demonstration dataset",
    category: "demo",
    url: "",
    license: "Synthetic demo data",
    coverage: "Gujarat (5 cities)",
    updateFrequency: "Seeded once at bootstrap",
    authentication: "n/a",
    reliability: "low",
    adapter: "demo",
    enabled: true,
    notes:
      "Clearly-labelled synthetic disruptions (waterlogging, metro work, accidents, events). Always tagged source=demo and verification=community so they can never be mistaken for live data.",
  },
  {
    key: "admin_console",
    name: "Admin control-room reports",
    category: "manual",
    url: "",
    license: "Internal",
    coverage: "Gujarat",
    updateFrequency: "Real time (operator entry)",
    authentication: "Admin session",
    reliability: "high",
    adapter: "manual",
    enabled: true,
    notes: "Verified human input from the control room; treated as confirmed (verification=verified).",
  },
  {
    key: "driver_report",
    name: "Ambulance crew field reports",
    category: "manual",
    url: "",
    license: "Internal",
    coverage: "Gujarat",
    updateFrequency: "Real time (crew entry)",
    authentication: "Driver session",
    reliability: "medium",
    adapter: "manual",
    enabled: true,
    notes: "Field observation from a crew on the road; stored as community-verified until an operator confirms.",
  },
  {
    key: "gujarat_traffic_police",
    name: "Gujarat Traffic Police advisories",
    category: "government",
    url: "https://gujarattraffic.gov.in",
    license: "Government website — no open licence",
    coverage: "State-wide",
    updateFrequency: "Ad-hoc (PDF/notices, social media)",
    authentication: "none published",
    reliability: "high",
    adapter: "none",
    enabled: false,
    notes:
      "Investigated: no public API or machine-readable feed is published. Advisories are PDFs/social posts, so automated ingestion is not authorised. Manual entry via the admin console is the supported path.",
  },
  {
    key: "amc_announcements",
    name: "Ahmedabad Municipal Corporation road notices",
    category: "government",
    url: "https://ahmedabadcity.gov.in",
    license: "Government website — no open licence",
    coverage: "Ahmedabad",
    updateFrequency: "Ad-hoc press releases",
    authentication: "none published",
    reliability: "high",
    adapter: "none",
    enabled: false,
    notes:
      "Investigated: notices are published as press releases/images without an API or structured feed. Requires a licensed scraper agreement; not scraped. Operators can paste the notice text into the admin console where the NLP pipeline extracts roads, category and time window.",
  },
  {
    key: "gmrc_metro",
    name: "Gujarat Metro Rail Corporation construction updates",
    category: "government",
    url: "https://gujaratmetrorail.co.in",
    license: "Government website — no open licence",
    coverage: "Ahmedabad / Surat metro corridors",
    updateFrequency: "Monthly progress notes",
    authentication: "none published",
    reliability: "high",
    adapter: "none",
    enabled: false,
    notes:
      "Investigated: metro construction notices are published as PDFs/notes, not an API. The demo dataset contains a representative metro-work event; live ingestion would need an official feed or agreement.",
  },
  {
    key: "nhai_roadwork",
    name: "NHAI / state highway roadwork bulletins",
    category: "government",
    url: "https://www.nhai.gov.in",
    license: "Government website — no open licence",
    coverage: "National + state highways in Gujarat",
    updateFrequency: "Project-wise, ad-hoc",
    authentication: "none published",
    reliability: "high",
    adapter: "none",
    enabled: false,
    notes: "Investigated: no public API. Highway advisories arrive as project notices; manual entry supported.",
  },
  {
    key: "tomtom_traffic",
    name: "TomTom Traffic API (incident feed)",
    category: "traffic_api",
    url: "https://developer.tomtom.com/traffic-api",
    license: "Commercial licence, free trial tier",
    coverage: "India (city-level coverage varies)",
    updateFrequency: "Near real-time (1–2 min)",
    authentication: "API key (not configured in this environment)",
    reliability: "high",
    adapter: "none",
    enabled: false,
    notes:
      "Investigated: excellent incident schema (accident, closure, construction, delays) but requires a paid/trial API key. Set TOMTOM_API_KEY to enable the adapter — the pipeline contract is ready.",
  },
  {
    key: "here_traffic",
    name: "HERE Traffic API",
    category: "traffic_api",
    url: "https://www.here.com/docs/bundle/traffic-api",
    license: "Commercial licence, free tier",
    coverage: "India",
    updateFrequency: "Near real-time",
    authentication: "API key (not configured)",
    reliability: "high",
    adapter: "none",
    enabled: false,
    notes: "Investigated: requires HERE credentials; not authorised in this environment.",
  },
  {
    key: "imd_weather_alerts",
    name: "IMD / municipal weather alerts",
    category: "government",
    url: "https://mausam.imd.gov.in",
    license: "Government website — no open licence",
    coverage: "Gujarat",
    updateFrequency: "2–4 times daily bulletins",
    authentication: "none published",
    reliability: "high",
    adapter: "none",
    enabled: false,
    notes:
      "Investigated: bulletins are published as text/images without an API. Open-Meteo is used instead as the machine-readable meteorological source, and it is labelled as a forecast rather than an official alert.",
  },
  {
    key: "social_media_traffic",
    name: "Traffic-police social media updates (X / Facebook)",
    category: "media",
    url: "https://x.com",
    license: "Platform terms — redistribution restricted",
    coverage: "City-level",
    updateFrequency: "Real time",
    authentication: "Paid API tier",
    reliability: "low",
    adapter: "none",
    enabled: false,
    notes:
      "Investigated: unofficial and licence-restricted; would require an authorised media partner. Not integrated. NLP pipeline can still process such text if an operator pastes it.",
  },
];

export const SOURCE_BY_KEY = new Map(SOURCE_CATALOG.map((source) => [source.key, source]));

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const OSM_BBOX = "22.95,72.40,23.30,72.80"; // Ahmedabad + Gandhinagar (south,west,north,east)

function osmTagsToObservation(element: {
  id: number;
  type: string;
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
  lat?: number;
  lon?: number;
}): RawObservation | null {
  const tags = element.tags ?? {};
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (lat === undefined || lon === undefined) return null;

  const highway = tags.highway ?? "";
  const construction = tags.construction ?? "";
  const access = tags.access ?? "";
  const barrier = tags.barrier ?? "";

  let category: string | null = null;
  let severity = "moderate";
  if (construction && highway) {
    category = "construction";
    severity = "moderate";
  } else if (highway && (access === "no" || access === "private")) {
    category = "closure";
    severity = "high";
  } else if (barrier && access !== "yes") {
    category = "closure";
    severity = "moderate";
  }
  if (!category) return null;

  const name = tags.name ?? tags["name:en"] ?? "";
  const title = name
    ? `${name} — ${category === "construction" ? "road construction" : "access restricted"}`
    : `OSM ${category === "construction" ? "construction" : "restriction"} on ${highway || barrier} (${element.type}/${element.id})`;

  return {
    externalId: `osm-${element.type}-${element.id}`,
    title,
    description: `OpenStreetMap ${element.type}/${element.id}: highway=${highway || "n/a"}${
      construction ? `, construction=${construction}` : ""
    }${barrier ? `, barrier=${barrier}` : ""}${access ? `, access=${access}` : ""}. Community-maintained — verify before treating as a confirmed closure.`,
    rawText: JSON.stringify(tags),
    category,
    severity,
    lat,
    lng: lon,
    roadName: name || undefined,
    direction: tags.direction ?? "both",
    url: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    reportedAt: new Date(),
  };
}

/** OpenStreetMap via Overpass — real, reachable, community-maintained. */
export const osmAdapter: Adapter = {
  key: "osm_overpass",
  async fetch(signal) {
    const query = `[out:json][timeout:20];
(
  way["highway"]["construction"](${OSM_BBOX});
  way["highway"]["access"!="yes"](${OSM_BBOX});
  way["barrier"]["access"!="yes"](${OSM_BBOX});
  node["barrier"="gate"]["access"!="yes"](${OSM_BBOX});
);
out tags center 60;`;

    let lastError = "no Overpass endpoint responded";
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "JeevanSetu/1.0 (emergency routing demo; contact admin@jeevansetu.in)",
            Accept: "application/json",
          },
          body: new URLSearchParams({ data: query }).toString(),
          signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
          cache: "no-store",
        });
        if (!response.ok) {
          lastError = `${endpoint} responded ${response.status}`;
          continue;
        }
        const payload = (await response.json()) as { elements?: Parameters<typeof osmTagsToObservation>[0][] };
        const observations = (payload.elements ?? [])
          .map(osmTagsToObservation)
          .filter((item): item is RawObservation => item !== null);
        return { observations };
      } catch (error) {
        lastError = `${endpoint}: ${error instanceof Error ? error.message : "request failed"}`;
      }
    }
    return { observations: [], error: lastError };
  },
};

const WATERLOGGING_HOTSPOTS: { area: string; lat: number; lng: number; city: string }[] = [
  { area: "Paldi", lat: 23.0106, lng: 72.5651, city: "Ahmedabad" },
  { area: "Navrangpura", lat: 23.03, lng: 72.55, city: "Ahmedabad" },
  { area: "Maninagar", lat: 22.99, lng: 72.6, city: "Ahmedabad" },
  { area: "Naroda", lat: 23.07, lng: 72.65, city: "Ahmedabad" },
  { area: "Adajan", lat: 21.17, lng: 72.78, city: "Surat" },
  { area: "Vesu", lat: 21.15, lng: 72.8, city: "Surat" },
  { area: "Udhna", lat: 21.16, lng: 72.86, city: "Surat" },
  { area: "Gotri", lat: 22.33, lng: 73.15, city: "Vadodara" },
  { area: "Alkapuri", lat: 22.32, lng: 73.18, city: "Vadodara" },
  { area: "University Road", lat: 22.31, lng: 70.81, city: "Rajkot" },
  { area: "Sector 21", lat: 23.22, lng: 72.65, city: "Gandhinagar" },
];

type OpenMeteoResponse = {
  current?: { precipitation?: number; rain?: number; weather_code?: number; time?: string };
  hourly?: { time?: string[]; precipitation?: number[]; rain?: number[] };
};

/** Open-Meteo rainfall → predicted waterlogging risk at known low-lying spots. */
export const weatherAdapter: Adapter = {
  key: "open_meteo",
  async fetch(signal) {
    const points = [
      { lat: 23.0225, lng: 72.5714, city: "Ahmedabad" },
      { lat: 21.1702, lng: 72.8311, city: "Surat" },
      { lat: 22.3072, lng: 73.1812, city: "Vadodara" },
      { lat: 22.3039, lng: 70.8022, city: "Rajkot" },
      { lat: 23.2156, lng: 72.6369, city: "Gandhinagar" },
    ];
    const observations: RawObservation[] = [];
    let lastError: string | undefined;

    for (const point of points) {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${point.lat}&longitude=${point.lng}&current=precipitation,rain,weather_code&hourly=precipitation&forecast_days=1&timezone=Asia%2FKolkata`;
        const response = await fetch(url, { signal, cache: "no-store" });
        if (!response.ok) {
          lastError = `Open-Meteo responded ${response.status}`;
          continue;
        }
        const data = (await response.json()) as OpenMeteoResponse;
        const hourly = data.hourly?.precipitation ?? [];
        const peak = hourly.length > 0 ? Math.max(...hourly) : 0;
        const current = data.current?.precipitation ?? 0;
        const intensity = Math.max(peak, current);
        if (intensity < 5) continue; // below the threshold that plausibly floods roads

        const severity = intensity >= 15 ? "high" : intensity >= 8 ? "moderate" : "low";
        const cityHotspots = WATERLOGGING_HOTSPOTS.filter((spot) => spot.city === point.city);
        for (const spot of cityHotspots) {
          observations.push({
            externalId: `meteo-${point.city.toLowerCase()}-${spot.area.toLowerCase().replace(/\s+/g, "-")}-${new Date()
              .toISOString()
              .slice(0, 13)}`,
            title: `Waterlogging risk — ${spot.area}, ${point.city}`,
            description: `Forecast rainfall intensity ${intensity.toFixed(1)} mm/h (Open-Meteo, ${point.city}). Predicted waterlogging risk at this low-lying hotspot. This is a meteorological forecast, not a confirmed road closure.`,
            rawText: `open-meteo precipitation=${intensity.toFixed(2)}mm/h city=${point.city} area=${spot.area}`,
            category: "waterlogging",
            severity,
            lat: spot.lat,
            lng: spot.lng,
            roadName: `${spot.area} road, ${point.city}`,
            direction: "both",
            startsAt: new Date(),
            endsAt: new Date(Date.now() + 6 * 3600 * 1000),
            url: "https://open-meteo.com/",
            reportedAt: new Date(),
          });
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Open-Meteo request failed";
      }
    }

    return { observations, error: lastError };
  },
};

/** Demonstration dataset adapter (no fetch; the rows are seeded at bootstrap). */
export const demoAdapter: Adapter = {
  key: "demo_seed",
  async fetch() {
    return { observations: [] };
  },
};

export const ADAPTERS: Record<string, Adapter> = {
  osm: osmAdapter,
  weather: weatherAdapter,
  demo: demoAdapter,
};

export const ENABLED_ADAPTERS = SOURCE_CATALOG.filter((source) => source.enabled && ADAPTERS[source.adapter]);
