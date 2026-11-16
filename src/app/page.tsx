import Link from "next/link";

import { db } from "@/db";
import { ambulances, drivers, emergencyRequests, hospitals, roadDisruptions, roadSegments } from "@/db/schema";
import { countDocuments } from "@/lib/counts";
import { ensureSeeded } from "@/lib/seed";
import { CITY_CENTERS } from "@/lib/roadNetwork";
import { Badge, Card } from "@/components/ui";

export const dynamic = "force-dynamic";

async function counts() {
  await ensureSeeded();
  const [h, a, d, r, seg, dis] = await Promise.all([
    countDocuments(hospitals),
    countDocuments(ambulances),
    countDocuments(drivers),
    countDocuments(emergencyRequests),
    countDocuments(roadSegments),
    countDocuments(roadDisruptions),
  ]);
  return {
    hospitals: h,
    ambulances: a,
    drivers: d,
    requests: r,
    segments: seg,
    disruptions: dis,
  };
}

const FLOW = [
  "Patient raises an emergency with GPS or a dropped pin",
  "Engine ranks hospitals by road travel time + emergency suitability",
  "Nearest feasible ambulance is claimed atomically and the driver is notified",
  "Driver accepts, navigates to the patient and confirms pickup (geofence or manual)",
  "Navigation switches to the hospital leg with live ETA",
  "Any new disruption triggers an automatic re-route with alternatives",
  "Hospital arrival completes the trip and releases the ambulance",
];

export default async function HomePage() {
  const stats = await counts();
  return (
    <div className="space-y-6">
      <section className="card home-hero relative overflow-hidden">
        <div className="grid gap-6 p-6 sm:p-8 lg:grid-cols-[1.4fr_1fr]">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="red">Emergency response</Badge>
              <Badge tone="blue">Gujarat coverage</Badge>
              <Badge tone="slate">Demo data</Badge>
            </div>
            <h1 className="mt-3 text-3xl font-black leading-tight text-white sm:text-4xl">
              The fastest <span className="text-red-400">feasible</span> ambulance route — recalculated as roads change.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-300">
              JeevanSetu models the road network as a weighted graph and routes ambulances with a time-dependent
              Dijkstra/A* search. Traffic level, road closures, accidents, metro and drainage work, waterlogging,
              damaged roads, diversions and public events all change edge weights — blocked segments are removed from
              the search entirely, and alternatives are compared by estimated travel time.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Link href="/patient" className="btn btn-emergency">
                🚨 Request an ambulance
              </Link>
              <Link href="/driver" className="btn">
                🚑 Driver console
              </Link>
              <Link href="/admin" className="btn">
                📊 Admin dashboard
              </Link>
            </div>
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[
                { label: "Hospitals", value: stats.hospitals },
                { label: "Ambulances", value: stats.ambulances },
                { label: "Drivers", value: stats.drivers },
                { label: "Road segments", value: stats.segments },
                { label: "Active disruptions", value: stats.disruptions },
                { label: "Requests handled", value: stats.requests },
              ].map((item) => (
                <div key={item.label} className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
                  <p className="text-lg font-bold tabular-nums text-slate-100">{item.value}</p>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">{item.label}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <Card className="card-pad">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Demo sign-in</p>
              <div className="mt-2 space-y-2 text-xs">
                <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                  <p className="font-semibold text-slate-200">Admin control room</p>
                  <p className="text-slate-400">admin@jeevansetu.in · admin123</p>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                  <p className="font-semibold text-slate-200">Driver (Ahmedabad ALS)</p>
                  <p className="text-slate-400">rakesh.patel@jeevansetu.in · driver123</p>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                  <p className="font-semibold text-slate-200">Other drivers</p>
                  <p className="text-slate-400">suresh.chauhan@… → hetal.trivedi@jeevansetu.in · driver123</p>
                </div>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                Patients do not need an account — the emergency form captures name, contact number and category.
              </p>
            </Card>
            <Card className="card-pad">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Coverage</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.keys(CITY_CENTERS).map((city) => (
                  <Badge key={city} tone="blue">
                    {city}
                  </Badge>
                ))}
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                Inter-city corridors (Ahmedabad–Gandhinagar, NE-1 to Vadodara, Vadodara–Surat, NH-27 to Rajkot) are part
                of the same graph, so cross-city transfers route on real road geometry.
              </p>
            </Card>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        {[
          {
            href: "/patient",
            title: "Patient / emergency",
            tone: "red" as const,
            points: [
              "Browser GPS or manual pin drop",
              "Nearest suitable hospital (road time + facilities)",
              "Desired hospital selection",
              "Live ambulance position, ETA and status",
            ],
          },
          {
            href: "/driver",
            title: "Ambulance driver",
            tone: "green" as const,
            points: [
              "Accept / reject the assigned pickup",
              "Turn-by-turn style route to the patient",
              "Geofence arrival + manual fallback",
              "Hospital leg, disruptions and trip completion",
            ],
          },
          {
            href: "/admin",
            title: "Admin control room",
            tone: "blue" as const,
            points: [
              "Fleet, driver and hospital management",
              "Live map of ambulances and disruptions",
              "Create / resolve road disruptions",
              "Route history and request monitoring",
            ],
          },
        ].map((module) => (
          <Card key={module.href} className="card-pad">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200">{module.title}</h2>
              <Badge tone={module.tone}>Open</Badge>
            </div>
            <ul className="mt-3 space-y-1.5 text-xs text-slate-400">
              {module.points.map((point) => (
                <li key={point} className="flex gap-2">
                  <span className="text-red-400">▸</span>
                  {point}
                </li>
              ))}
            </ul>
            <Link href={module.href} className="btn btn-sm mt-4 w-full">
              Launch module
            </Link>
          </Card>
        ))}
      </section>

      <section className="card card-pad">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200">End-to-end workflow</h2>
        <ol className="mt-3 grid gap-2 text-xs text-slate-400 sm:grid-cols-2 lg:grid-cols-4">
          {FLOW.map((step, index) => (
            <li key={step} className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
              <span className="mr-2 font-bold text-red-400">{index + 1}.</span>
              {step}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
