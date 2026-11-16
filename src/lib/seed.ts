
import { db, eq } from "@/db";
import {
  ambulances,
  drivers,
  emergencyRequests,
  hospitals,
  notifications,
  roadDisruptions,
  roadSegments,
  routes,
  trips,
  users,
} from "@/db/schema";
import { hashPassword } from "@/lib/auth";
import { slugName } from "@/lib/loginName";
import { geohash, haversine, type LatLng } from "@/lib/geo";
import { NETWORK } from "@/lib/roadNetwork";

let seedPromise: Promise<void> | null = null;

/** rakesh.patel@jeevansetu.in style logins derived from the driver's name. */
export function slugifyEmail(name: string): string {
  return slugName(name);
}

/**
 * One-off, idempotent migration: give every driver a login derived from their
 * own name (replacing the old driverN@jeevansetu.in placeholders).
 */
/** Renames applied to databases created before the approved-name policy. */
const RENAMED_DRIVERS: Record<string, string> = {
  "Imran Shaikh": "Ramesh Pandya",
  "Kiran Bhai": "Kiran Joshi",
};

/**
 * Brings an existing database up to date with the current fleet roster: renames drivers to approved
 * names (login follows the new name) and adds any roster ambulance that is not stored yet. Idempotent.
 */
export async function ensureFleetUpdates(): Promise<{ renamed: number; added: number }> {
  let renamed = 0;
  let added = 0;
  const driverRows = await db.select().from(drivers);
  const userRows = await db.select().from(users);

  for (const driver of driverRows) {
    const next = RENAMED_DRIVERS[driver.name];
    if (!next) continue;
    await db.update(drivers).set({ name: next }).where(eq(drivers.id, driver.id));
    const user = driver.userId ? userRows.find((u) => u.id === driver.userId) : undefined;
    if (user) {
      const base = slugifyEmail(next);
      let email = `${base}@jeevansetu.in`;
      let suffix = 2;
      while (userRows.some((other) => other.id !== user.id && other.email === email)) {
        email = `${base}${suffix}@jeevansetu.in`;
        suffix += 1;
      }
      await db.update(users).set({ name: next, email }).where(eq(users.id, user.id));
      user.name = next;
      user.email = email;
    }
    renamed += 1;
  }

  const ambulanceRows = await db.select().from(ambulances);
  const hospitalRows = (await db.select().from(hospitals)) as unknown as { id: number; code: string }[];
  for (const seed of AMBULANCE_SEED) {
    if (ambulanceRows.some((a) => a.code === seed.code)) continue;
    const hospital = hospitalRows.find((h) => h.code === seed.hospitalCode);
    const email = `${slugifyEmail(seed.driverName)}@jeevansetu.in`;
    let user = userRows.find((u) => u.email === email);
    if (!user) {
      const inserted = await db
        .insert(users)
        .values({
          name: seed.driverName,
          email,
          phone: seed.driverPhone,
          role: "driver",
          passwordHash: await hashPassword("driver123"),
        })
        .returning();
      user = inserted[0] as (typeof userRows)[number];
      userRows.push(user);
    }
    const insertedDriver = await db
      .insert(drivers)
      .values({
        userId: user.id,
        name: seed.driverName,
        phone: seed.driverPhone,
        licenseNo: `GJ-DL-${seed.code.slice(-2)}-2024`,
        status: seed.status === "offline" ? "offline" : "online",
        lat: seed.lat,
        lng: seed.lng,
        geohash: geohash(seed.lat, seed.lng),
        lastSeenAt: new Date(),
      })
      .returning();
    const driver = insertedDriver[0] as { id: number };
    const insertedAmbulance = await db
      .insert(ambulances)
      .values({
        code: seed.code,
        type: seed.type,
        status: seed.status,
        lat: seed.lat,
        lng: seed.lng,
        geohash: geohash(seed.lat, seed.lng),
        driverId: driver.id,
        hospitalId: hospital?.id ?? null,
        facilities: seed.facilities,
        lastSeenAt: new Date(),
      })
      .returning();
    const ambulance = insertedAmbulance[0] as { id: number };
    await db.update(drivers).set({ ambulanceId: ambulance.id }).where(eq(drivers.id, driver.id));
    ambulanceRows.push(ambulance as (typeof ambulanceRows)[number]);
    added += 1;
  }
  return { renamed, added };
}

export async function ensureDriverUsernames(): Promise<number> {
  const [driverRows, userRows] = await Promise.all([
    db.select().from(drivers),
    db.select().from(users),
  ]);
  let updated = 0;
  for (const driver of driverRows) {
    if (!driver.userId) continue;
    const user = userRows.find((candidate) => candidate.id === driver.userId);
    if (!user) continue;
    if (!/^driver\d+@jeevansetu\.in$/i.test(user.email)) continue;
    const base = slugifyEmail(driver.name) || "driver";
    let candidate = `${base}@jeevansetu.in`;
    let suffix = 2;
    while (userRows.some((other) => other.id !== user.id && other.email === candidate)) {
      candidate = `${base}${suffix}@jeevansetu.in`;
      suffix += 1;
    }
    await db.update(users).set({ email: candidate }).where(eq(users.id, user.id));
    user.email = candidate;
    updated += 1;
  }
  return updated;
}

/** Idempotent, lazily-invoked demo data bootstrap (safe under concurrency). */
export async function ensureSeeded(): Promise<void> {
  if (!seedPromise) {
    seedPromise = runSeed().catch((error) => {
      seedPromise = null;
      throw error;
    });
  }
  return seedPromise;
}

type HospitalSeed = {
  code: string;
  name: string;
  address: string;
  city: string;
  district: string;
  lat: number;
  lng: number;
  phone: string;
  emergencyLevel: string;
  traumaLevel: string;
  facilities: string[];
  capabilities: string[];
  verified: boolean;
};

const HOSPITAL_SEED: HospitalSeed[] = [
  {
    code: "HSP-AMD-01",
    name: "Civil Hospital Ahmedabad",
    address: "Shahibaug, Ahmedabad, Gujarat 380004",
    city: "Ahmedabad",
    district: "Ahmedabad",
    lat: 23.0333,
    lng: 72.5833,
    phone: "+91 79 2268 6000",
    emergencyLevel: "Level I",
    traumaLevel: "Level 1 trauma centre",
    facilities: ["emergency", "icu", "trauma", "cardiac", "neuro", "obstetric", "nicu", "pediatric", "burns", "oxygen", "surgery"],
    capabilities: ["24x7 emergency", "CT & MRI", "Blood bank", "Burn unit"],
    verified: true,
  },
  {
    code: "HSP-AMD-02",
    name: "U.N. Mehta Institute of Cardiology",
    address: "Shahibaug, Ahmedabad, Gujarat 380004",
    city: "Ahmedabad",
    district: "Ahmedabad",
    lat: 23.0301,
    lng: 72.5581,
    phone: "+91 79 2268 7000",
    emergencyLevel: "Level II",
    traumaLevel: "Cardiac trauma capable",
    facilities: ["emergency", "icu", "cardiac", "oxygen", "surgery"],
    capabilities: ["Cath lab", "24x7 cardiac emergency"],
    verified: true,
  },
  {
    code: "HSP-AMD-03",
    name: "GCS Hospital Ahmedabad",
    address: "Near Kankaria, Ahmedabad, Gujarat 380008",
    city: "Ahmedabad",
    district: "Ahmedabad",
    lat: 23.0203,
    lng: 72.5451,
    phone: "+91 79 2545 0000",
    emergencyLevel: "Level II",
    traumaLevel: "General trauma",
    facilities: ["emergency", "icu", "trauma", "obstetric", "nicu", "pediatric", "oxygen", "surgery"],
    capabilities: ["24x7 emergency", "NICU", "Blood bank"],
    verified: true,
  },
  {
    code: "HSP-AMD-04",
    name: "Zydus Hospital",
    address: "S G Highway, Ahmedabad, Gujarat 380015",
    city: "Ahmedabad",
    district: "Ahmedabad",
    lat: 23.0086,
    lng: 72.506,
    phone: "+91 79 6600 0000",
    emergencyLevel: "Level II",
    traumaLevel: "Level 2 trauma centre",
    facilities: ["emergency", "icu", "trauma", "cardiac", "neuro", "obstetric", "nicu", "pediatric", "oxygen", "surgery"],
    capabilities: ["24x7 emergency", "Stroke unit", "Cath lab"],
    verified: true,
  },
  {
    code: "HSP-AMD-05",
    name: "Apollo Hospital Ahmedabad",
    address: "S G Highway, Ahmedabad, Gujarat 380054",
    city: "Ahmedabad",
    district: "Ahmedabad",
    lat: 23.002,
    lng: 72.523,
    phone: "+91 79 6600 6600",
    emergencyLevel: "Level I",
    traumaLevel: "Level 1 trauma centre",
    facilities: ["emergency", "icu", "trauma", "cardiac", "neuro", "obstetric", "nicu", "pediatric", "burns", "oxygen", "dialysis", "surgery"],
    capabilities: ["24x7 emergency", "Polytrauma protocol", "Air ambulance tie-up"],
    verified: true,
  },
  {
    code: "HSP-AMD-06",
    name: "Sterling Hospital Ahmedabad",
    address: "S G Highway, Ahmedabad, Gujarat 380015",
    city: "Ahmedabad",
    district: "Ahmedabad",
    lat: 23.0181,
    lng: 72.5301,
    phone: "+91 79 4000 4000",
    emergencyLevel: "Level II",
    traumaLevel: "General trauma",
    facilities: ["emergency", "icu", "cardiac", "neuro", "obstetric", "oxygen", "surgery"],
    capabilities: ["24x7 emergency", "Stroke ready"],
    verified: true,
  },
  {
    code: "HSP-AMD-07",
    name: "SVP Hospital Ahmedabad",
    address: "Nava Wadaj, Ahmedabad, Gujarat 380013",
    city: "Ahmedabad",
    district: "Ahmedabad",
    lat: 22.9903,
    lng: 72.5801,
    phone: "+91 79 2740 0000",
    emergencyLevel: "Level II",
    traumaLevel: "General trauma",
    facilities: ["emergency", "icu", "trauma", "obstetric", "nicu", "pediatric", "oxygen", "surgery"],
    capabilities: ["24x7 emergency", "Burns support"],
    verified: true,
  },
  {
    code: "HSP-AMD-08",
    name: "Nightingale Hospital (NCH)",
    address: "Paldi, Ahmedabad, Gujarat 380007",
    city: "Ahmedabad",
    district: "Ahmedabad",
    lat: 23.0106,
    lng: 72.5651,
    phone: "+91 79 2658 0000",
    emergencyLevel: "Level III",
    traumaLevel: "",
    facilities: ["emergency", "icu", "pediatric", "oxygen"],
    capabilities: ["24x7 emergency"],
    verified: false,
  },
  {
    code: "HSP-GND-01",
    name: "GMERS Medical College & Hospital, Gandhinagar",
    address: "Sector 12, Gandhinagar, Gujarat 382007",
    city: "Gandhinagar",
    district: "Gandhinagar",
    lat: 23.2201,
    lng: 72.6501,
    phone: "+91 79 2324 0000",
    emergencyLevel: "Level I",
    traumaLevel: "Level 1 trauma centre",
    facilities: ["emergency", "icu", "trauma", "cardiac", "neuro", "obstetric", "nicu", "pediatric", "burns", "oxygen", "surgery"],
    capabilities: ["24x7 emergency", "Teaching hospital", "Blood bank"],
    verified: true,
  },
  {
    code: "HSP-GND-02",
    name: "Government General Hospital Gandhinagar",
    address: "Near Sector 1, Gandhinagar, Gujarat 382001",
    city: "Gandhinagar",
    district: "Gandhinagar",
    lat: 23.2156,
    lng: 72.6369,
    phone: "+91 79 2322 0000",
    emergencyLevel: "Level II",
    traumaLevel: "General trauma",
    facilities: ["emergency", "icu", "obstetric", "nicu", "pediatric", "oxygen", "surgery"],
    capabilities: ["24x7 emergency"],
    verified: true,
  },
  {
    code: "HSP-VDD-01",
    name: "SSG Hospital Vadodara",
    address: "Raopura, Vadodara, Gujarat 390001",
    city: "Vadodara",
    district: "Vadodara",
    lat: 22.3101,
    lng: 73.1901,
    phone: "+91 265 243 0000",
    emergencyLevel: "Level I",
    traumaLevel: "Level 1 trauma centre",
    facilities: ["emergency", "icu", "trauma", "cardiac", "neuro", "obstetric", "nicu", "pediatric", "burns", "oxygen", "surgery"],
    capabilities: ["24x7 emergency", "Polytrauma unit", "Blood bank"],
    verified: true,
  },
  {
    code: "HSP-VDD-02",
    name: "Sterling Hospital Vadodara",
    address: "Gotri Road, Vadodara, Gujarat 390021",
    city: "Vadodara",
    district: "Vadodara",
    lat: 22.3001,
    lng: 73.1701,
    phone: "+91 265 300 0000",
    emergencyLevel: "Level II",
    traumaLevel: "General trauma",
    facilities: ["emergency", "icu", "cardiac", "neuro", "obstetric", "oxygen", "surgery"],
    capabilities: ["24x7 emergency", "Cath lab"],
    verified: true,
  },
  {
    code: "HSP-VDD-03",
    name: "Sunrise Hospital Vadodara",
    address: "Alkapuri, Vadodara, Gujarat 390007",
    city: "Vadodara",
    district: "Vadodara",
    lat: 22.3201,
    lng: 73.1801,
    phone: "+91 265 660 0000",
    emergencyLevel: "Level III",
    traumaLevel: "",
    facilities: ["emergency", "icu", "obstetric", "nicu", "pediatric", "oxygen"],
    capabilities: ["24x7 emergency"],
    verified: false,
  },
  {
    code: "HSP-SRT-01",
    name: "New Civil Hospital Surat",
    address: "Majura Gate, Surat, Gujarat 395003",
    city: "Surat",
    district: "Surat",
    lat: 21.1801,
    lng: 72.8401,
    phone: "+91 261 246 0000",
    emergencyLevel: "Level I",
    traumaLevel: "Level 1 trauma centre",
    facilities: ["emergency", "icu", "trauma", "cardiac", "neuro", "obstetric", "nicu", "pediatric", "burns", "oxygen", "surgery"],
    capabilities: ["24x7 emergency", "Burns unit", "Blood bank"],
    verified: true,
  },
  {
    code: "HSP-SRT-02",
    name: "Kiran Hospital Surat",
    address: "Udhna Main Road, Surat, Gujarat 394210",
    city: "Surat",
    district: "Surat",
    lat: 21.1701,
    lng: 72.8301,
    phone: "+91 261 230 0000",
    emergencyLevel: "Level II",
    traumaLevel: "General trauma",
    facilities: ["emergency", "icu", "trauma", "obstetric", "nicu", "pediatric", "oxygen", "surgery"],
    capabilities: ["24x7 emergency", "NICU"],
    verified: true,
  },
  {
    code: "HSP-SRT-03",
    name: "CIMS Hospital Surat",
    address: "Vesu, Surat, Gujarat 395007",
    city: "Surat",
    district: "Surat",
    lat: 21.1501,
    lng: 72.8001,
    phone: "+91 261 300 0000",
    emergencyLevel: "Level II",
    traumaLevel: "General trauma",
    facilities: ["emergency", "icu", "cardiac", "neuro", "obstetric", "oxygen", "surgery"],
    capabilities: ["24x7 emergency", "Cath lab"],
    verified: true,
  },
  {
    code: "HSP-RJT-01",
    name: "Rajkot Civil Hospital",
    address: "Near Race Course, Rajkot, Gujarat 360001",
    city: "Rajkot",
    district: "Rajkot",
    lat: 22.3001,
    lng: 70.8001,
    phone: "+91 281 248 0000",
    emergencyLevel: "Level II",
    traumaLevel: "General trauma",
    facilities: ["emergency", "icu", "trauma", "obstetric", "nicu", "pediatric", "oxygen", "surgery"],
    capabilities: ["24x7 emergency", "Blood bank"],
    verified: true,
  },
  {
    code: "HSP-RJT-02",
    name: "Wockhardt Hospital Rajkot",
    address: "University Road, Rajkot, Gujarat 360005",
    city: "Rajkot",
    district: "Rajkot",
    lat: 22.3101,
    lng: 70.8101,
    phone: "+91 281 660 0000",
    emergencyLevel: "Level II",
    traumaLevel: "General trauma",
    facilities: ["emergency", "icu", "cardiac", "neuro", "obstetric", "oxygen", "surgery"],
    capabilities: ["24x7 emergency", "Cath lab"],
    verified: true,
  },
];

type AmbulanceSeed = {
  code: string;
  type: string;
  status: string;
  lat: number;
  lng: number;
  hospitalCode: string;
  facilities: string[];
  driverName: string;
  driverPhone: string;
};

const AMBULANCE_SEED: AmbulanceSeed[] = [
  { code: "GJ-AMB-01", type: "ALS", status: "available", lat: 23.0345, lng: 72.5845, hospitalCode: "HSP-AMD-01", facilities: ["oxygen", "defibrillator", "ventilator"], driverName: "Rakesh Patel", driverPhone: "+91 98250 11001" },
  { code: "GJ-AMB-02", type: "BLS", status: "available", lat: 23.0095, lng: 72.5075, hospitalCode: "HSP-AMD-04", facilities: ["oxygen", "first_aid"], driverName: "Suresh Chauhan", driverPhone: "+91 98250 11002" },
  { code: "GJ-AMB-03", type: "ICU", status: "available", lat: 23.0032, lng: 72.5245, hospitalCode: "HSP-AMD-05", facilities: ["ventilator", "monitor", "infusion"], driverName: "Ramesh Pandya", driverPhone: "+91 98250 11003" },
  { code: "GJ-AMB-04", type: "BLS", status: "available", lat: 23.2168, lng: 72.6385, hospitalCode: "HSP-GND-02", facilities: ["oxygen", "first_aid"], driverName: "Bhavesh Solanki", driverPhone: "+91 98250 11004" },
  { code: "GJ-AMB-05", type: "ALS", status: "available", lat: 22.3085, lng: 73.1825, hospitalCode: "HSP-VDD-01", facilities: ["oxygen", "defibrillator"], driverName: "Nilesh Desai", driverPhone: "+91 98250 11005" },
  { code: "GJ-AMB-06", type: "BLS", status: "offline", lat: 22.3115, lng: 73.1915, hospitalCode: "HSP-VDD-01", facilities: ["oxygen", "first_aid"], driverName: "Mahesh Parmar", driverPhone: "+91 98250 11006" },
  { code: "GJ-AMB-07", type: "ALS", status: "available", lat: 21.1715, lng: 72.8325, hospitalCode: "HSP-SRT-02", facilities: ["oxygen", "defibrillator", "monitor"], driverName: "Jignesh Vasava", driverPhone: "+91 98250 11007" },
  { code: "GJ-AMB-08", type: "BLS", status: "available", lat: 21.1815, lng: 72.8415, hospitalCode: "HSP-SRT-01", facilities: ["oxygen", "first_aid"], driverName: "Dinesh Rathod", driverPhone: "+91 98250 11008" },
  { code: "GJ-AMB-09", type: "BLS", status: "available", lat: 22.3051, lng: 70.8035, hospitalCode: "HSP-RJT-01", facilities: ["oxygen", "first_aid"], driverName: "Kiran Joshi", driverPhone: "+91 98250 11009" },
  { code: "GJ-AMB-10", type: "Neonatal", status: "available", lat: 23.0462, lng: 72.5215, hospitalCode: "HSP-AMD-02", facilities: ["incubator", "ventilator", "monitor"], driverName: "Hetal Trivedi", driverPhone: "+91 98250 11010" },
  // Gandhinagar fleet (added): positions are on the OpenStreetMap road network.
  { code: "GJ-AMB-11", type: "ALS", status: "available", lat: 23.222991, lng: 72.648339, hospitalCode: "HSP-GND-01", facilities: ["oxygen", "defibrillator", "ventilator"], driverName: "Ketan Thakkar", driverPhone: "+91 98250 11011" },
  { code: "GJ-AMB-12", type: "BLS", status: "available", lat: 23.213836, lng: 72.640161, hospitalCode: "HSP-GND-02", facilities: ["oxygen", "first_aid"], driverName: "Dharmesh Rana", driverPhone: "+91 98250 11012" },
  { code: "GJ-AMB-13", type: "ICU", status: "available", lat: 23.226935, lng: 72.654037, hospitalCode: "HSP-GND-01", facilities: ["ventilator", "monitor", "infusion"], driverName: "Jaydip Gohil", driverPhone: "+91 98250 11013" },
  { code: "GJ-AMB-14", type: "BLS", status: "available", lat: 23.208439, lng: 72.633026, hospitalCode: "HSP-GND-02", facilities: ["oxygen", "first_aid"], driverName: "Mayur Bhatt", driverPhone: "+91 98250 11014" },
  { code: "GJ-AMB-15", type: "Neonatal", status: "available", lat: 23.230315, lng: 72.659921, hospitalCode: "HSP-GND-01", facilities: ["incubator", "ventilator", "monitor"], driverName: "Nirav Raval", driverPhone: "+91 98250 11015" },
];

type DisruptionSeed = {
  title: string;
  type: string;
  severity: string;
  description: string;
  lat: number;
  lng: number;
  reportedBy: string;
};

const DISRUPTION_SEED: DisruptionSeed[] = [
  {
    title: "Waterlogging on Ashram Road",
    type: "waterlogging",
    severity: "critical",
    description: "Knee-deep water near Paldi cross road after heavy rain. Two-wheelers and light vehicles stuck.",
    lat: 23.0106,
    lng: 72.5651,
    reportedBy: "AMC control room",
  },
  {
    title: "Metro construction barricading Ring Road",
    type: "metro_work",
    severity: "high",
    description: "Metro rail pier work between Mansi circle and Kankaria. Single lane open, expect 12-18 min delay.",
    lat: 23.04,
    lng: 72.56,
    reportedBy: "Gujarat Metro Rail Corp",
  },
  {
    title: "Two-wheeler accident on SG Highway",
    type: "accident",
    severity: "moderate",
    description: "Collision near Prahladnagar flyover, one lane blocked, traffic police on site.",
    lat: 23.01,
    lng: 72.525,
    reportedBy: "Traffic police Ahmedabad",
  },
  {
    title: "Flyover repair work on Surat Ring Road",
    type: "construction",
    severity: "high",
    description: "Expansion joint repair on Adajan flyover, one carriageway closed during peak hours.",
    lat: 21.1702,
    lng: 72.86,
    reportedBy: "Surat Municipal Corporation",
  },
  {
    title: "Public event traffic on Gandhinagar Main Road",
    type: "public_event",
    severity: "moderate",
    description: "State-level cultural event at Sector 21 ground. Diversions active from 17:00 to 22:00.",
    lat: 23.2156,
    lng: 72.66,
    reportedBy: "Gandhinagar police",
  },
  {
    title: "Drainage line work on Vadodara Ring Road",
    type: "drainage",
    severity: "moderate",
    description: "Storm water line replacement near Gotri junction. Service lane closed.",
    lat: 22.3072,
    lng: 73.2,
    reportedBy: "VMC ward office",
  },
  {
    title: "Pipeline repair on Rajkot Ring Road",
    type: "pipeline",
    severity: "low",
    description: "Water pipeline leak repair near University Road junction, slow moving traffic.",
    lat: 22.3039,
    lng: 70.83,
    reportedBy: "Jal Board Rajkot",
  },
  {
    title: "Damaged road surface on NE-1 Expressway",
    type: "damaged_road",
    severity: "high",
    description: "Deep potholes near km 42 after heavy truck movement. Ambulances advised to use service road.",
    lat: 22.72,
    lng: 72.82,
    reportedBy: "NHAI field unit",
  },
];

function trafficForCode(code: string): string {
  let hash = 0;
  for (let i = 0; i < code.length; i += 1) hash = (hash * 31 + code.charCodeAt(i)) % 1000;
  if (hash % 7 === 0) return "heavy";
  if (hash % 3 === 0) return "moderate";
  return "low";
}

async function runSeed(): Promise<void> {
  await db.transaction(async (tx) => {

    const userCount = await tx.select({ id: users.id }).from(users).limit(1);
    if (userCount.length === 0) {
      const adminHash = await hashPassword("admin123");
      const driverHash = await hashPassword("driver123");
      await tx.insert(users).values({
        name: "Emergency Control Room",
        email: "admin@jeevansetu.in",
        phone: "+91 79 1800 100",
        role: "admin",
        passwordHash: adminHash,
      });
      for (let i = 0; i < AMBULANCE_SEED.length; i += 1) {
        const seed = AMBULANCE_SEED[i];
        await tx.insert(users).values({
          name: seed.driverName,
          email: `${slugifyEmail(seed.driverName)}@jeevansetu.in`,
          phone: seed.driverPhone,
          role: "driver",
          passwordHash: driverHash,
        });
      }
    }

    const hospitalCount = await tx.select({ id: hospitals.id }).from(hospitals).limit(1);
    if (hospitalCount.length === 0) {
      await tx.insert(hospitals).values(
        HOSPITAL_SEED.map((h) => ({
          ...h,
          geohash: geohash(h.lat, h.lng),
        })),
      );
    }

    const segmentCount = await tx.select({ id: roadSegments.id }).from(roadSegments).limit(1);
    if (segmentCount.length === 0) {
      const rows = NETWORK.edges.map((edge) => {
        const start = { lat: edge.geometry[0][1], lng: edge.geometry[0][0] };
        const end = { lat: edge.geometry[1][1], lng: edge.geometry[1][0] };
        return {
          segmentCode: edge.code,
          roadName: edge.roadName,
          city: edge.city,
          district: edge.district,
          roadClass: edge.roadClass,
          startNode: edge.from,
          endNode: edge.to,
          startLat: start.lat,
          startLng: start.lng,
          endLat: end.lat,
          endLng: end.lng,
          geometry: edge.geometry,
          distanceMeters: edge.distanceMeters,
          baseSpeedKph: edge.baseSpeedKph,
          trafficLevel: trafficForCode(edge.code),
          status: "open",
          severity: 0,
        };
      });
      for (let i = 0; i < rows.length; i += 100) {
        await tx.insert(roadSegments).values(rows.slice(i, i + 100));
      }
    }

    const ambulanceCount = await tx.select({ id: ambulances.id }).from(ambulances).limit(1);
    if (ambulanceCount.length === 0) {
      const hospitalRows = await tx.select().from(hospitals);
      const driverRows = await tx.select().from(drivers);
      const userRows = await tx.select().from(users);
      const hospitalByCode = new Map(hospitalRows.map((h) => [h.code, h]));
      for (let i = 0; i < AMBULANCE_SEED.length; i += 1) {
        const seed = AMBULANCE_SEED[i];
        const hospital = hospitalByCode.get(seed.hospitalCode);
        const driverUser = userRows.find((u) => u.email === `${slugifyEmail(seed.driverName)}@jeevansetu.in`);
        const insertedDriver = await tx
          .insert(drivers)
          .values({
            userId: driverUser?.id ?? null,
            name: seed.driverName,
            phone: seed.driverPhone,
            licenseNo: `GJ-DL-${2020 + i}-${1000 + i}`,
            status: seed.status === "offline" ? "offline" : "online",
            lat: seed.lat,
            lng: seed.lng,
            geohash: geohash(seed.lat, seed.lng),
            lastSeenAt: new Date(),
          })
          .returning();
        const driver = insertedDriver[0];
        const insertedAmbulance = await tx
          .insert(ambulances)
          .values({
            code: seed.code,
            type: seed.type,
            status: seed.status,
            lat: seed.lat,
            lng: seed.lng,
            geohash: geohash(seed.lat, seed.lng),
            driverId: driver?.id ?? null,
            hospitalId: hospital?.id ?? null,
            facilities: seed.facilities,
            lastSeenAt: new Date(),
          })
          .returning();
        if (driver && insertedAmbulance[0]) {
          await tx.update(drivers).set({ ambulanceId: insertedAmbulance[0].id }).where(eq(drivers.id, driver.id));
        }
      }
      // driverRows referenced only to keep ordering deterministic
      void driverRows;
    }

    const disruptionCount = await tx.select({ id: roadDisruptions.id }).from(roadDisruptions).limit(1);
    if (disruptionCount.length === 0) {
      const segments = await tx.select().from(roadSegments);
      for (const seed of DISRUPTION_SEED) {
        let best: { id: number; distance: number; geometry: [number, number][]; roadName: string } | null = null;
        for (const segment of segments) {
          const mid = segment.geometry[Math.floor(segment.geometry.length / 2)];
          const distance = haversine({ lat: seed.lat, lng: seed.lng }, { lat: mid[1], lng: mid[0] });
          if (!best || distance < best.distance) best = { id: segment.id, distance, geometry: segment.geometry, roadName: segment.roadName };
        }
        await tx.insert(roadDisruptions).values({
          segmentId: best?.id ?? null,
          title: seed.title,
          type: seed.type,
          severity: seed.severity,
          status: "active",
          description: seed.description,
          lat: seed.lat,
          lng: seed.lng,
          geohash: geohash(seed.lat, seed.lng),
          geometry: best?.geometry ?? null,
          reportedBy: seed.reportedBy,
          source: "demo",
          sourceKey: "demo_seed",
          sourceName: "JeevanSetu demonstration dataset",
          license: "Synthetic demo data",
          confidence: 0.9,
          verification: "community",
          direction: "both",
          rawText: seed.description,
          extractedRoadName: best?.roadName ?? null,
          matchedSegmentIds: best ? [best.id] : [],
          matchMethod: best ? "geometry" : "none",
          needsReview: false,
          startsAt: new Date(Date.now() - 1000 * 60 * 60 * 3),
          eventStartsAt: new Date(Date.now() - 1000 * 60 * 60 * 3),
          eventEndsAt: new Date(Date.now() + 1000 * 60 * 60 * 12),
          lastFetchedAt: new Date(),
        });
      }
    }

    const requestCount = await tx.select({ id: emergencyRequests.id }).from(emergencyRequests).limit(1);
    if (requestCount.length === 0) {
      const hospitalRows = await tx.select().from(hospitals);
      const ambulanceRows = await tx.select().from(ambulances);
      const history: { category: string; hospitalCode: string; ambulanceCode: string; pickup: LatLng; hoursAgo: number }[] = [
        { category: "cardiac", hospitalCode: "HSP-AMD-05", ambulanceCode: "GJ-AMB-03", pickup: { lat: 23.0181, lng: 72.5301 }, hoursAgo: 26 },
        { category: "trauma", hospitalCode: "HSP-SRT-01", ambulanceCode: "GJ-AMB-08", pickup: { lat: 21.1702, lng: 72.86 }, hoursAgo: 19 },
        { category: "obstetric", hospitalCode: "HSP-VDD-01", ambulanceCode: "GJ-AMB-05", pickup: { lat: 22.3001, lng: 73.1701 }, hoursAgo: 8 },
      ];
      let counter = 0;
      for (const item of history) {
        counter += 1;
        const hospital = hospitalRows.find((h) => h.code === item.hospitalCode);
        const ambulance = ambulanceRows.find((a) => a.code === item.ambulanceCode);
        if (!hospital || !ambulance) continue;
        const createdAt = new Date(Date.now() - item.hoursAgo * 3600 * 1000);
        const inserted = await tx
          .insert(emergencyRequests)
          .values({
            publicId: `JS-${String(1000 + counter)}`,
            patientName: ["Demo Patient A", "Demo Patient B", "Demo Patient C"][counter - 1] ?? "Demo Patient",
            patientPhone: "+91 90000 00000",
            category: item.category,
            severity: "serious",
            status: "completed",
            mode: "nearest",
            hospitalId: hospital.id,
            ambulanceId: ambulance.id,
            driverId: ambulance.driverId,
            pickupLat: item.pickup.lat,
            pickupLng: item.pickup.lng,
            pickupAddress: "Demo pickup location (seeded history)",
            etaMinutes: 12,
            distanceKm: 8.4,
            notes: "Seeded historical trip for route history demonstration.",
            createdAt,
            updatedAt: createdAt,
            completedAt: new Date(createdAt.getTime() + 45 * 60 * 1000),
          })
          .returning();
        const request = inserted[0];
        if (!request) continue;
        await tx.insert(trips).values({
          requestId: request.id,
          ambulanceId: ambulance.id,
          driverId: ambulance.driverId ?? 0,
          status: "completed",
          startedAt: createdAt,
          acceptedAt: new Date(createdAt.getTime() + 60 * 1000),
          arrivedPickupAt: new Date(createdAt.getTime() + 12 * 60 * 1000),
          pickedUpAt: new Date(createdAt.getTime() + 16 * 60 * 1000),
          arrivedHospitalAt: new Date(createdAt.getTime() + 40 * 60 * 1000),
          completedAt: new Date(createdAt.getTime() + 45 * 60 * 1000),
          distanceKm: 8.4,
          durationSeconds: 2700,
        });
        await tx.insert(routes).values({
          requestId: request.id,
          mode: "nearest",
          origin: [item.pickup.lng, item.pickup.lat],
          destination: [hospital.lng, hospital.lat],
          geometry: [
            [item.pickup.lng, item.pickup.lat],
            [hospital.lng, hospital.lat],
          ],
          distanceMeters: 8400,
          durationSeconds: 1080,
          alternatives: [],
          disruptions: [],
          trafficSummary: { level: "moderate" },
          createdAt,
        });
      }
      await tx.insert(notifications).values({
        role: "admin",
        type: "system",
        title: "Demo dataset initialised",
        body: "Seeded hospitals, ambulances, drivers, road network and demo disruptions for Gujarat.",
      });
    }

    await ensureDriverUsernames();
  });
  await ensureFleetUpdates();
}
