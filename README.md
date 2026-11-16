# JeevanSetu — AI-Powered Dynamic Ambulance Routing (Gujarat)

JeevanSetu is an end-to-end emergency ambulance routing platform. It computes the **fastest feasible**
ambulance route on a real road graph (not straight-line distance), continuously re-weights the graph with
traffic, closures, accidents, construction, metro/drainage/pipeline work, waterlogging, damaged roads,
diversions and public events, and re-routes automatically when a disruption affects an active journey.

The repository contains three complete interfaces (patient, driver, admin), a routing engine, a dispatch
engine with atomic ambulance claiming, a persistence layer, and a realtime channel.

---

## 1. Stack actually running in this workspace

The project brief asked for **Python + FastAPI + Pydantic + PyMongo + MongoDB Atlas** with an OSRM/GraphHopper
backend. This sandbox provides a managed **Next.js (App Router) + PostgreSQL** runtime and does not expose a
Python process or a MongoDB daemon, so the application is implemented on the available runtime while keeping
the requested architecture, domain model and API surface intact:

| Brief | Implementation here | Notes |
| --- | --- | --- |
| FastAPI + Pydantic | Next.js Route Handlers + Zod-style validators in `src/lib/api.ts` | Same REST contract, typed request validation, central error handling |
| PyMongo / MongoDB `jeevansetu_db` | PostgreSQL via Drizzle ORM (`src/db/schema.ts`) | Every Mongo collection is a table; GeoJSON stored in `jsonb`; `geohash` prefix columns replace 2dsphere for proximity scans |
| Mongo GeoJSON + 2dsphere | GeoJSON LineString/Point in `jsonb` + geohash + btree indexes | Routing uses the stored geometry directly |
| NetworkX / A* / Dijkstra | `src/lib/routing.ts` — time-dependent Dijkstra with edge penalties for alternatives | Deterministic, no external service required |
| WebSockets | Server-Sent Events (`/api/stream`) + polling fallback | The managed Next.js runtime has no WS upgrade hook; semantics are identical (server push, auto-reconnect) |
| Shapely / GeoPandas | `src/lib/geo.ts` — haversine, polyline projection, slicing, point-along-line | Pure TS, no native deps |
| Docker Compose | `Dockerfile` + `docker-compose.yml` | Postgres + app, schema push on start |

Nothing in the UI claims a live government feed: **all hospitals, ambulances, drivers, road segments and
disruptions are clearly-labelled demonstration data** (see `src/lib/seed.ts`). No bed availability or hospital
capability is fabricated as "live".

To enable Google building/place search, enable **Places API (New)** and billing in Google Cloud, then add
`GOOGLE_MAPS_API_KEY=your-key` to `.env.local` for local development. Restrict the key to the Places API and keep
it server-side; do not expose it through a `NEXT_PUBLIC_` variable. Docker Compose reads the same variable from
the shell or its `.env` file.

---

## 2. Feature map

### A. Patient / emergency interface — `/patient`
- Browser GPS detection, click-to-drop pin, and pickup-place search. Set `GOOGLE_MAPS_API_KEY` to use Google Places building/business results; without it, search falls back to OpenStreetMap Nominatim, whose building coverage varies. Google Places requires enabling Places API (New) and billing for the key.
- Emergency category (cardiac, stroke, trauma, respiratory, obstetric, pediatric, burns, poisoning, other) + severity.
- **Mode 1 — nearest suitable hospital:** every nearby hospital is routed with the same engine; ranking blends
  *road travel time* with *emergency-care suitability* for the category (facility match, trauma level, ER level).
- **Mode 2 — desired hospital:** pick any registered hospital; the route is still computed on the live graph.
- Shows the assigned ambulance, driver contact, live ambulance position, ETA, road distance, status timeline,
  active disruptions, primary + alternative routes, and a public tracking link (`/track/[publicId]`).

### B. Driver interface — `/driver`
- Session authentication (bcrypt password hashing, httpOnly session cookie, role-based authorisation).
- Online/offline availability (locked while an emergency is active).
- Receives the assigned pickup, accepts **or rejects** (rejection automatically re-dispatches to the next
  best ambulance and never double-assigns a unit).
- Turn-by-turn style map of the actual road geometry to the patient, live ETA, traffic and disruptions.
- **Geofence arrival detection** (150 m) with automatic pickup confirmation, plus a manual fallback button.
- After pickup the navigation automatically switches to the hospital leg (new route + ETA stored).
- "Advance 900 m (demo)" moves the unit along the computed route so the workflow can be exercised without a
  vehicle; hospital-arrival and trip-completion actions release the ambulance back to the available pool.

### C. Admin control room — `/admin`
- Counters: total requests, active requests, fleet size, available/busy/offline, hospitals, drivers,
  ongoing trips, active disruptions, completed trips.
- Live map of every ambulance, hospital and disruption.
- Manage ambulances (status), drivers (duty status), hospitals (activate/deactivate, capabilities).
- Report a road disruption by clicking the map (type + severity + description) — this immediately re-routes
  every active trip and stores the new route/ETA.
- Resolve disruptions (also triggers re-routing).
- Route history (every computed route with mode, distance, duration) and trip lifecycle table.

### D. Routing engine (`src/lib/routing.ts`)
- Graph = intersections (nodes) + road segments (edges) with geometry, distance, base speed, class, traffic level.
- Edge weight = `distance / effectiveSpeed`, where effective speed applies the time-of-day congestion curve,
  the segment traffic level and the disruption severity multiplier.
- Fully blocked edges (closures, severe waterlogging/damaged roads) are **removed** from the search.
- Origin/destination are snapped onto the closest road **edge** (first/last mile connectors), so a route never
  degenerates to a straight line.
- Alternatives are generated by penalising the edges of the best path and re-running the search; options are
  compared by estimated travel time.
- Road network: 111 junctions / 120 segments / ~738 km across Ahmedabad, Gandhinagar, Vadodara, Surat and Rajkot,
  including the NE-1 (Ahmedabad–Vadodara), NH-48 (Vadodara–Surat) and NH-27 (Ahmedabad–Rajkot) corridors.
  Corridors are split at real geometric intersections so the graph is a single connected component
  (verified by `GET /api/network`).

### E. Dispatch engine (`src/lib/dispatch.ts`)
- Candidate ambulances are ranked by **road** travel time to the patient (8 nearest by straight line are
  evaluated, then routed).
- The chosen unit is claimed with a conditional `UPDATE … WHERE status = 'available' RETURNING`, so two
  concurrent dispatch loops can never assign the same ambulance (race-condition safe without transactions).
- Every state change writes an assignment row, a trip row, a route row and notifications.

---

## 3. Data model (PostgreSQL tables mirroring the Mongo collections)

`users`, `sessions`, `hospitals`, `drivers`, `ambulances`, `patients`, `emergency_requests`,
`ambulance_assignments`, `trips`, `road_segments`, `road_disruptions`, `routes`, `notifications`.

GeoJSON payloads (`geometry`, `origin`, `destination`) are stored as `jsonb`; every located collection carries a
`geohash` column plus a `(lat, lng)` index for proximity pre-filtering.

---

## 4. API reference (all JSON)

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness + DB probe |
| GET | `/api/network` | Graph diagnostics (nodes, edges, components, km) |
| GET | `/api/live` | Public live snapshot (ambulances, requests, disruptions, trips) |
| GET | `/api/stream` | Server-Sent Events realtime channel |
| POST | `/api/auth/login` · `/api/auth/logout` · GET `/api/auth/me` | Session auth |
| GET/POST/PATCH | `/api/hospitals` · POST `/api/hospitals/rank` | Hospital registry + suitability ranking |
| GET/POST/PATCH | `/api/ambulances` | Fleet management |
| GET/POST/PATCH | `/api/drivers` | Driver management |
| GET/POST | `/api/requests` · GET `/api/requests/[id]` | Create emergency, list, live detail |
| POST | `/api/requests/[id]/respond` | Driver accept/reject (reject re-dispatches) |
| POST | `/api/requests/[id]/pickup` | Pickup confirmation (geofence or manual) |
| POST | `/api/requests/[id]/hospital-arrival` · `/complete` | Hospital arrival, trip completion |
| GET/POST | `/api/requests/[id]/route` | Current leg plan / forced recalculation |
| POST | `/api/routing/preview` | Ad-hoc route plan (origin/destination) |
| GET/POST/PATCH | `/api/disruptions` | List / report / resolve disruptions (re-routes active trips) |
| GET | `/api/driver/context` | Driver session, ambulance, active request, route, disruptions |
| POST | `/api/driver/position` · `/api/driver/simulate` | GPS update / demo movement along route |
| GET | `/api/admin/stats` | Full control-room dataset |
| POST | `/api/admin/seed` | Idempotent demo-data bootstrap |
| GET | `/api/geocode?q=` | Place/address search (Google Places when `GOOGLE_MAPS_API_KEY` is configured; otherwise OpenStreetMap Nominatim) |
| GET | `/api/geocode?lat=&lng=` | Reverse-geocode proxy (OpenStreetMap Nominatim) |

---

## 5. Run locally

```bash
npm install
# .env → MONGODB_URI=mongodb://localhost:27017 and MONGODB_DATABASE=jeevansetu_db
npm run dev                   # http://localhost:3000  (collections are created on first write)
```

Demo data seeds itself lazily on the first request (idempotent, guarded by a Postgres advisory lock).
To force it: `POST /api/admin/seed` as admin, or `./scripts/db-init.sh --seed`.

Docker: `docker compose up --build` (app on `:3000`, Postgres on `:5432`).

### Demo credentials
| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@jeevansetu.in` | `admin123` |
| Driver 1 (GJ-AMB-01, ALS Ahmedabad) | `driver1@jeevansetu.in` | `driver123` |
| Drivers 2–10 | `driver2@jeevansetu.in` … `driver10@jeevansetu.in` | `driver123` |

Patients do not log in — the emergency form captures name, contact number and category.

---

## 6. End-to-end acceptance walkthrough

1. Open `/patient`, allow GPS (or click the map), fill name/phone, choose a category → the ranked hospital list
   shows road travel time + suitability.
2. Submit → the request is created, the nearest feasible ambulance is claimed atomically and the driver notified.
3. Open `/driver`, sign in as the driver of the assigned unit (the code is shown on the patient screen) → accept.
4. The map shows the real road route to the patient; use **Advance 900 m (demo)** or drive with GPS.
5. Within 150 m the pickup auto-confirms (or press **Confirm pickup**) → navigation switches to the hospital leg.
6. In `/admin` → *Overview* → report a disruption on the route → every active trip is re-routed and the new
   ETA appears on the driver console and the patient tracking page.
7. Driver presses **Mark hospital arrival** then **Complete trip** → ambulance returns to `available`.
8. `/admin` shows the updated counters, route history and trip lifecycle.

A scripted version of this flow was executed against the production build during development (request →
assign → accept → simulate → pickup → disruption re-route → arrival → complete → admin snapshot).

---

## 7. Project layout

```
src/
  app/                 # pages + API route handlers
    patient/ driver/ admin/ track/[publicId]/
    api/…              # auth, hospitals, ambulances, drivers, requests, disruptions, driver, admin, stream, live, network
  components/          # PatientConsole, DriverConsole, AdminConsole, TrackView, MapCanvas/MapView, ui kit
  db/                  # Drizzle schema + pooled client
  lib/
    routing.ts         # time-dependent Dijkstra/A*, alternatives, blocking, snapping
    roadNetwork.ts     # Gujarat corridor definitions + junction splitting + graph builder
    dispatch.ts        # hospital ranking, atomic assignment, trip lifecycle, live snapshot
    seed.ts            # clearly-labelled demo data bootstrap
    geo.ts             # haversine, projection, polyline maths, geohash
    domain.ts          # categories, severities, statuses, suitability scoring
    auth.ts api.ts     # sessions, password hashing, validation helpers
scripts/db-init.sh     # schema push + optional seed
Dockerfile, docker-compose.yml, .env.example
```

## 8. Known limitations (intentional)

- Road network, hospitals, fleet and disruptions are demo data for Gujarat; they are not a live government feed.
- Traffic is modelled with a time-of-day congestion curve plus per-segment levels, not a commercial traffic API.
  `OSRM_BASE_URL` is reserved for swapping in an external router.
- Hospital capability data is registered demo data; no live bed availability is claimed.
- Realtime uses SSE instead of WebSockets because of the managed runtime's constraints.

---

# PHASE 2 — Real-time road-disruption intelligence

This phase adds the data-source layer, NLP extraction, geospatial matching, confidence-aware
routing weights and the automatic rerouting monitor. The persistence layer is unchanged
(Drizzle ORM over the existing PostgreSQL instance — no new database technology was introduced).

## 2.1 Source evaluation (what is actually integrated)

| Source | Type | Status | Why |
| --- | --- | --- | --- |
| OpenStreetMap · Overpass API | Open data (ODbL) | **Integrated** | Real query for `highway=construction`, `access!=yes`, `barrier` restrictions. Community-maintained → stored as `verification=community`, `confidence≈0.55–0.7`, flagged for review. |
| Open-Meteo forecast | Weather (CC-BY-4.0) | **Integrated** | Hourly rainfall → *predicted waterlogging risk* at known low-lying hotspots. Stored as `verification=unverified`, labelled as a forecast, never as a confirmed closure. |
| Nominatim geocoding | Open data (ODbL) | **Integrated** | Resolves free-text location mentions before segment matching. |
| Demo dataset | Synthetic | **Integrated (labelled)** | `source=demo_seed`, `verification=community`. |
| Admin console / crew reports | Manual | **Integrated** | Operator report = `verified`; crew report = `community`. |
| Gujarat Traffic Police, AMC, GMRC, NHAI, IMD | Government | **Not integrated** | Investigated: no public API or machine-readable feed is published (PDFs/social posts only). No scraping without authorisation; operators can paste notice text and the NLP pipeline will process it. |
| TomTom / HERE / Google traffic | Commercial | **Not configured** | Require API keys (`TOMTOM_API_KEY`, `HERE_API_KEY`, `GOOGLE_MAPS_API_KEY`). The adapter contract is ready; set the key to enable. |
| Social media traffic handles | Media | **Not integrated** | Platform terms restrict redistribution. |

`GET /api/sources` returns this catalogue with live adapter status (`active`, `degraded`,
`unavailable`, `planned`), last error and last item count — the UI never presents a failing
source as healthy.

## 2.2 Ingestion pipeline

`POST /api/ingest` (admin) runs, per source, in isolation:

1. **Fetch** with a hard timeout (20 s) and a descriptive User-Agent.
2. **Parse** structured payloads (Overpass JSON, Open-Meteo JSON) into raw observations.
3. **Extract** road name (gazetteer + `NH/SH/NE` patterns), category, severity, direction and
   time window with the rule-based NLP in `src/lib/nlp.ts` (every keyword hit is returned).
4. **Geocode** free-text locations (gazetteer → Nominatim, cached).
5. **Match** to road segments (`src/lib/matching.ts`) using geometry projection + road-name
   similarity + direction; ambiguous matches are flagged, never silently applied.
6. **Score** confidence = 0.6·NLP + 0.4·match, adjusted for source reliability.
7. **Store/upsert** on `(source_key, external_id)` so updates replace duplicates.
8. **Update** existing events instead of duplicating them.
9. **Expire** events whose `event_ends_at` has passed (`status='expired'`).
10. **Queue** low-confidence/unmatched reports in `disruption_reports` for human verification.
11. Write an `ingestion_runs` row per source and refresh `data_sources` status.
12. Run the **reroute monitor** so any change immediately affects active trips.

## 2.3 Confidence-aware routing weights

For every edge, `weight = normal time + traffic delay + disruption penalty`, where the
disruption penalty is:

```
penalty = 1 + (severityMultiplier - 1) × confidence × freshness × directionFactor
```

* `severityMultiplier`: low 1.15 · moderate 1.35 · high 1.7 · critical 2.8
* `freshness`: 1.0 normally, 0.7 when < 1 h remains, 0.6 for events older than 48 h, 0 when expired
* `directionFactor`: 1.15 with the flow, 1.0 cross-flow, 0.35 against the flow, 1.0 for `both`
* **Blocking** (edge removed from the search) requires: type ∈ {closure, waterlogging,
  damaged_road} **and** severity ∈ {high, critical} **and** verification ∈ {verified, community}
  **and** confidence ≥ 0.6 **and** not expired. Low-confidence or unverified reports can only
  slow traffic — they can never silently close a road.
* Every route option now returns `breakdown` (base / traffic / disruption / connector seconds)
  and `dataQuality` (verified / community / unverified / low-confidence / expired counts and
  average confidence) so ETA changes are explainable.

## 2.4 Automatic rerouting monitor

`POST /api/reroute/monitor` (also runs automatically after ingestion and after any manual
disruption change):

1. For each active trip, project every active disruption onto the **stored route geometry**.
2. If nothing is within 150 m of the route, no action is taken.
3. Otherwise recompute the leg and compare:
   * blocked road → immediate reroute,
   * ETA improvement > 8 % (or > 10 % shorter distance) → reroute,
   * otherwise record `no_change` (hysteresis prevents route flapping).
4. Persist the new route, update the request ETA/distance, write a `reroute_events` row and
   notify the driver + admin.
5. If no feasible alternative exists, record `no_alternative` and tell the driver to hold.

## 2.5 New API endpoints

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/sources` | Source catalogue + live adapter status |
| POST/GET | `/api/ingest` | Run ingestion / list ingestion runs |
| GET | `/api/disruptions` | Disruptions + verification summary + pending queue |
| POST | `/api/disruptions/[id]/verify` | Verify or reject a queued report |
| POST/GET | `/api/reroute/monitor` | Run the monitor / list reroute decisions |
| GET/POST | `/api/selftest` | 13-scenario deterministic test suite |

## 2.6 New tables

`data_sources`, `ingestion_runs`, `disruption_reports`, `reroute_events`, plus
disruption-intelligence columns on `road_disruptions` (`source_key`, `source_name`,
`source_url`, `licence`, `external_id`, `confidence`, `verification`, `direction`, `raw_text`,
`extracted_road_name`, `matched_segment_ids`, `match_method`, `needs_review`,
`event_starts_at`, `event_ends_at`, `last_fetched_at`, `updated_at`).

## 2.7 Test scenarios

`GET /api/selftest` (admin/driver) executes and reports on:

1. Normal road conditions · 2. Heavy traffic · 3. Complete road closure · 4. Partial
construction obstruction · 5. Metro construction · 6. Verified severe waterlogging ·
7. Multiple simultaneous disruptions · 8. Expired events ignored · 9. New disruption during
travel · 10. Conflicting reports (verified closure wins) · 11. No alternative route available ·
12. NLP extraction accuracy · 13. Geospatial segment matching.

---

# PHASE 3 — Live ambulance movement & name-based driver logins

## 3.1 Live ambulance tracking (moving unit, on the road)

`advanceActiveAmbulances()` in `src/lib/dispatch.ts` runs on every live snapshot
(`/api/stream`, `/api/live`) and every request-detail poll:

1. For each active trip (`assigned`, `enroute_pickup`, `enroute_hospital`) it loads the
   latest stored route for that request.
2. Progress is derived from **elapsed time vs. the route's estimated duration**, and the
   ambulance position is advanced **along the stored road geometry** (`pointAlongPolyline`),
   never in a straight line between two coordinates.
3. The new position is written to `ambulances` with `movementSource: "engine"`.
4. Real crew GPS always wins: if `movementSource === "driver"` and the last fix is younger
   than 8 s, the engine leaves the unit alone.
5. On reaching the end of the pickup leg the geofence pickup is confirmed automatically;
   on reaching the hospital the arrival is recorded — the driver still confirms completion.

Each detail payload now carries `ambulanceProgress` (0..1 along the route),
`routeDurationSeconds` and `ambulanceUpdatedAt`. The driver console interpolates between
polls with `useAnimatedProgress()` (`src/lib/movingPoint.ts`) so the marker glides along the
road every second, and shows **remaining road distance, remaining time and the next road**.

## 3.2 Driver logins derived from the driver's name

Seed users and the login migration now use `slugifyEmail(driver.name)`:

| Driver | Login |
| --- | --- |
| Rakesh Patel | `rakesh.patel@jeevansetu.in` |
| Suresh Chauhan | `suresh.chauhan@jeevansetu.in` |
| Imran Shaikh | `imran.shaikh@jeevansetu.in` |
| Bhavesh Solanki | `bhavesh.solanki@jeevansetu.in` |
| Nilesh Desai | `nilesh.desai@jeevansetu.in` |
| Mahesh Parmar | `mahesh.parmar@jeevansetu.in` |
| Jignesh Vasava | `jignesh.vasava@jeevansetu.in` |
| Dinesh Rathod | `dinesh.rathod@jeevansetu.in` |
| Kiran Bhai | `kiran.bhai@jeevansetu.in` |
| Hetal Trivedi | `hetal.trivedi@jeevansetu.in` |

All use the password `driver123`. `ensureDriverUsernames()` migrates any legacy
`driverN@jeevansetu.in` account in place (idempotent, collision-safe), so existing
deployments keep working. Admin remains `admin@jeevansetu.in / admin123`.

---

# PHASE 4 — Road-to-road ambulance navigation (OpenStreetMap routing)

The earlier route engine connected junctions of a hand-drawn road graph, so the
drawn line and the moving ambulance cut across blocks. Routing now uses real
OpenStreetMap road geometry:

| Layer | Source | Notes |
| --- | --- | --- |
| Road routes + alternatives | **OSRM** (`router.project-osrm.org`) | Road-following geometry (≤ 20 m between points), road names, turn-by-turn steps, up to 3 alternatives |
| Failover | **Valhalla** (`valhalla1.openstreetmap.de`) | Same OSM network, polyline6 shapes |
| Offline fallback | Graph engine (`src/lib/routing.ts`) | Only used when no routing service answers; options are labelled `engine: graph` |

Code: `src/lib/roadRouter.ts` (providers, decoding, cache) and `src/lib/roadRouting.ts`
(disruption-aware planner used by hospital ranking, ambulance allocation, detail views,
rerouting and the routing preview API).

**Disruption handling on road routes**

* Each candidate is scored against live disruptions within 120 m of its road.
* Verified/community closures, waterlogging and damaged roads (high/critical, confidence ≥ 0.6)
  **block** the candidate; other events add penalties scaled by severity and confidence.
* If the fastest road is blocked, the planner asks OSRM for detours through points 900 m and
  1600 m beside the blockage on both sides, and keeps the ones that avoid it.
* Congestion adds an estimated delay from the time-of-day model (labelled as an estimate).

**Movement**

The ambulance is placed on the stored road route (the same geometry that is drawn), so it
follows every bend and turn. Driver consoles show the next manoeuvre and distance from the
route's turn steps.

**Configuration** — `OSRM_BASE_URL` and `VALHALLA_BASE_URL` (see `.env.example`). The public
demo servers are for light use; use a self-hosted OSRM/Valhalla on a Gujarat OSM extract for
production.

**Verified:** request → OSRM route (183 points, named roads, turns) → closure placed on the
route → detour 1.7 km from the closure on different streets → ambulance advances along the road.

---

# PHASE 5 — Pickup → hospital hand-off, admin live tracking, admin-created requests

## 5.1 Ambulance goes to the hospital after pickup

* Pickup is confirmed automatically when the ambulance reaches the patient on its road route
  (or manually by the crew). The confirmation is an **atomic status claim**, so it happens
  exactly once even when several dashboards poll at the same time.
* The hospital road route is computed from the patient's pickup point and stored as the new
  active route; the ambulance then drives that route (`purpose: hospital`) and the status
  becomes `enroute_hospital`. Arrival at the hospital is recorded automatically.
* A zero-length leg (the ambulance is already at the patient) completes immediately.

## 5.2 Movement stays on the road

* **Device GPS is route-locked.** A phone/browser fix moves the ambulance only if it lies within
  60 m of the assigned road route. Otherwise the response says it is off-route and the
  ambulance keeps following the route (previously a desk browser's location could pull the
  ambulance off the map).
* **Off-road positions snap back.** If the stored position drifts more than 15 m from the route,
  the engine returns it to the time-based position on the route.
* **Labelled sources.** `engine` = road route engine, `driver` = device GPS on route,
  `simulation` = demo "advance" button. The admin view shows which one is in use.

## 5.3 Admin live tracking of all drivers — `Admin → Live tracking`

* `GET /api/admin/live` (admin only) returns every ambulance with its driver, mission
  (`to_patient`, `to_hospital`, `at_hospital`), patient, hospital, road route, progress, speed,
  remaining distance/time and last update.
* The map draws every ambulance on its road route with a direction arrow, glides it between
  2-second refreshes, and lets you select a driver to follow them.
* Summary cards: fleet size, moving now, driving to patient, to hospital, available, offline.

## 5.4 Admin can create requests — `Admin → Create request`

* Phone or walk-in intake: patient name/phone, category, severity, nearest or desired hospital,
  call notes and pickup location (map click, GPS or the Ahmedabad centre pin).
* Dispatches exactly like an app request (hospital ranking, nearest free ambulance, driver
  notification). Requests are stored with `channel: control_room`.
* Control-room requests require an admin session; the public endpoint rejects them (401).

## 5.5 Access control

* `/api/live` and `/api/stream` are admin-only (they expose the whole fleet).

## Verified (local production build)

| Scenario | Result |
| --- | --- |
| Admin creates a desired-hospital request | saved with `channel: control_room`, assigned, ETA shown |
| Anonymous control-room create | 401 |
| Device GPS 6.9 km off the route | rejected (ambulance not moved) |
| Device GPS on the route | accepted, ambulance follows it |
| Full trip: 1.36 km pickup drive → auto pickup → 1.22 km hospital drive → arrival | 366 s, max 9 m off the road, 0 backward jumps |
| Admin live view during trip | `to_patient` → `to_hospital` → `at_hospital`, driver name and source shown |
| Zero-length pickup (ambulance already at patient) | pickup confirmed instantly, hospital route started |

---

# PHASE 6 — Hospital hand-off, closest-ambulance dispatch, login fixes

## Ambulance goes to the hospital from the patient's location
* After pickup the hospital route starts at the patient's pickup point and the unit drives it.
* Every re-route (disruption monitor, manual recalculation, periodic refresh) starts from the
  unit's **current position**, never from the patient's pickup point. Previously a re-route during
  the hospital leg sent the unit back toward the patient.
* Movement is dead-reckoned from the unit's own position at the leg's planned speed, so a unit
  already part-way along a road keeps moving instead of waiting for a timeline.
* Movement starts when the driver accepts the pickup.

## Closest ambulance by road
* Every available ambulance is ranked by **road travel time** to the patient in one OSRM table
  request (straight-line distance is only a fallback estimate).
* The closest five get full disruption-aware road routes; the fastest feasible unit is claimed
  atomically.
* Every request returns `ambulanceCandidates`: selected / ranked / unreachable / unavailable, with
  road distance, road time and the reason. Shown on the patient screen and in admin "Create request".
* Device GPS outside a trip no longer moves an ambulance, so dispatch uses the fleet's real positions.

## Login
* Accepts a username (`rakesh.patel`), a display name (`Rakesh Patel`), or the full email.
* A valid session token is never blocked by a stale cookie left from a previous server run.
* The session token is kept in memory as well as in browser storage.
* When a session ends the console returns to sign-in with "Your session has ended", instead of an
  authentication error banner.

## Verified (local production build)
| Check | Result |
| --- | --- |
| Dispatch vs OSRM road-fastest ambulance (3 locations) | matched in 3 of 3 |
| Idle device GPS outside a trip | ambulance position unchanged |
| Full trip, no simulation buttons: pickup → hospital → arrival | 322 s, max 8 m off road, 0 backward jumps |
| Closure on the hospital route during the trip | unit keeps moving from its position; route starts 151 m along the road, not at the patient |
| Login: `admin`, `rakesh.patel`, `Rakesh Patel`, full email | all accepted; wrong password rejected |
| Stale cookie + valid token | accepted |
| Browser: admin and driver sign-in, expired session, closest-ambulance display | 6 of 6 |
| Self-test suite | 13 of 13 |

---

# PHASE 7 — Pickup → nearest hospital automatically; live status for admin

* **Movement runs on the server.** `src/instrumentation.ts` starts a 2-second timer (`src/lib/liveTicker.ts`) that advances every active ambulance and performs pickup and hospital hand-offs. Nothing depends on a browser being open.
* **Hand-off at pickup.** When the ambulance reaches the patient (automatically or on the crew's button), the destination is chosen from the patient's exact pickup point:
  * nearest-mode requests: the nearest suitable hospital by road time (`rankHospitals`);
  * desired-hospital requests: the hospital the patient asked for, falling back to the nearest one only if it is inactive or has no road route.
  The hand-off is claimed atomically and rolled back on failure so it can be retried.
* **Admin live status** (`Admin → Live tracking`): a live trip table with request, ambulance and driver, stage (to patient / patient on board / at hospital), next stop, remaining distance and time, and last update. Selecting a trip shows its timeline: dispatched, accepted, picked up, nearest hospital selected, arrived, completed.

**Verified:** pickup detected automatically 157 s after acceptance (route 156 s) with no API calls during the drive; hand-off to the nearest hospital by the server's road-time ranking; full hospital leg to arrival; admin live table and timeline checked in a real browser; self-tests 13/13.

---

# PHASE 8 — Three route options (fastest / little fast / slow) and traffic heatmap

## Road network
* `scripts/build-road-graph.mjs` builds the road network from OpenStreetMap (Overpass API) for Ahmedabad, Gandhinagar and the corridor between them: 89,042 junctions and 114,640 road segments, saved to `data/road-graph/gujarat-osm.json.gz` (2.25 MB). The app loads this file at start-up, so routing does not depend on an external service while it runs.
* Data © OpenStreetMap contributors, ODbL 1.0.
* Areas outside the graph fall back to the OSRM road service, and those routes are labelled as such.

## Algorithms (`src/lib/pathfinding.ts`, `src/lib/graphRouting.ts`)
* **Fastest — A\*** with a Euclidean heuristic (straight-line distance divided by the top road speed, scaled by 0.99 so it never overestimates). Returns the optimal traffic-aware time.
* **Little fast — Dijkstra** with the fastest route's roads penalised by 35%, 80% or 160% (the first penalty that yields a clearly different road is used).
* **Slow alternative — Dijkstra** with the fastest and little-fast roads penalised by 120%, 300% or 600%, requiring a clearly different corridor.
* Penalties only raise the search cost. Reported durations are the true traffic-aware times, and the options are ranked by them.
* Every route option reports the algorithm, junctions examined and compute time. Dijkstra is also run on the fastest query for comparison (`POST /api/routing/preview` with `"comparison": true`).
* Euclidean (planar) distance is used to snap the patient, ambulance and hospital positions to the nearest junctions, with a connector time at 22 km/h.

**Verified:** A\* and Dijkstra return the same optimal time in every test; A\* examined about 2 to 4 times fewer junctions (for example 875 against 1,905, and 8,620 against 15,464).

## Traffic heatmap (estimated)
* Congestion per road segment = time-of-day load × road-class sensitivity (arterials congest most), plus a term for signalised junctions.
* Reported incidents set a minimum congestion on the roads they touch: low 0.32, moderate 0.45, high 0.62, critical 0.80 (scaled by confidence and freshness). Closures and verified severe obstructions block the segment.
* Colours: **green** free flow, **orange** moderate, **red** heavy. Legends say "Estimated — not live sensor data".
* The traffic time of day uses Asia/Kolkata. `GET /api/traffic?lat&lng&radius[&at]` returns the coloured network; `at` simulates a time of day and is reported as simulated.

## Driver choice
* The driver sees the three options after accepting the pickup and chooses one (`POST /api/requests/[id]/route-option`). The chosen route becomes the active route, the ambulance drives it, and the patient, tracking and admin views show its heatmap.
* Automatic rerouting keeps the chosen option when it is still available.
* Roads within 200 m of the patient or hospital are never closed. A flooded road at the pickup is kept open but heavily congested, so the patient stays reachable.

## Verified
| Check | Result |
| --- | --- |
| Three options from Ashram Road to Civil Hospital, Paldi to Apollo, Gandhinagar to the city centre | three options each, ordered by time, distinct corridors |
| Traffic colours by time of day (simulated) | night all green; 10:00 mixed; 18:30 mostly orange and red; route times rise at peak |
| Closure on the fastest route | the new fastest route passes 831 m from the closure; the closed road is not used; resolving the closure restores the original route |
| Driver selects each option through the API | active route and admin live view update; invalid option rejected (400) |
| Driver console in a real browser | three cards, selected route highlighted, heatmap drawn, selection confirmed, no page errors |

---

# PHASE 9 — Alternative routes on a PC, Gandhinagar fleet, approved driver names, admin driver creation

## Why the alternative routes did not show after downloading the project
The three route options are computed from the OpenStreetMap road network, stored in `data/road-graph/gujarat-osm.json.gz` (about 2.3 MB). When that folder was missing from the download, the loader quietly returned nothing and routing fell back to the public road service, which returns one route. The screens showed one card with no explanation.

What changed:
- **The loader finds the file reliably.** It checks `JEEVANSETU_ROAD_GRAPH` (if set), then `data/road-graph/…` under the project folder, and it re-checks instead of caching a failure.
- **Automatic rebuild.** On start, if the file is missing, the server builds it from OpenStreetMap in the background (`scripts/build-road-graph.mjs`, a few minutes, needs internet). Routing keeps working meanwhile and switches to three options when the build finishes. Set `JEEVANSETU_AUTO_BUILD_GRAPH=0` to turn this off.
- **Clear message on every screen.** When fewer than three options are available, the driver, patient and tracking screens explain that the road network is not loaded and how to restore it.
- **Status endpoint.** `GET /api/network` reports whether the road network is loaded, its file path, and how many junctions and segments it has.

Setting up on another computer:
1. Unzip the whole project, including the `data/` folder if present.
2. `npm install`, then `npm run dev` (or `npm run build` and `npm start`).
3. If the log says the road network is not loaded, let the automatic rebuild finish (internet needed), or run `node scripts/build-road-graph.mjs`, then restart.

Verified: a copy without `data/` showed one option, rebuilt the network by itself, and then returned three options (fastest, little fast, slow).

## Gandhinagar fleet
Five ambulances were added in Gandhinagar, GJ-AMB-11 to GJ-AMB-15 (ALS, BLS, ICU, BLS, Neonatal). Each sits on a road centreline near GMERS Hospital or Government General Hospital. Existing databases receive them on start-up without a reset (`ensureFleetUpdates`, idempotent).

## Approved driver names
Driver names must be a Hindu first name and surname from the approved lists in `src/lib/hindiNames.ts`. The server rejects any other name, and the admin form suggests valid names. Two existing drivers were renamed to approved names (Imran Shaikh → Ramesh Pandya, Kiran Bhai → Kiran Joshi). Logins follow the new names.

Note: a list check can only confirm a name is on the approved list; it cannot verify a person's religion.

## Admin adds drivers
`Admin → Drivers → Add a driver`:
- Name (with Suggest name), phone, licence, initial password (at least 6 characters).
- Ambulance: none yet, an existing unassigned ambulance, or a new ambulance of a chosen type at a chosen base hospital.
- The login is created from the name (for example `harsh.mehta`); a duplicate gets a number suffix. The result shows the login and password to share with the driver.

Verified over the API: non-approved and one-word names are rejected (400); a second Pravin Shah gets `pravin.shah2`; an ambulance that already has a driver is refused (409); a driver cannot create drivers (403); anonymous requests are refused (401); a new driver signs in with the generated username.
