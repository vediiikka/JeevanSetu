import { ok, readJson, requireEnum, requireLat, requireLng, route } from "@/lib/api";
import { EMERGENCY_CATEGORIES } from "@/lib/domain";
import { rankHospitals } from "@/lib/dispatch";

export const dynamic = "force-dynamic";

export const POST = route(async (request: Request) => {
  const body = await readJson(request);
  const pickup = { lat: requireLat(body.lat, "latitude"), lng: requireLng(body.lng, "longitude") };
  const category = requireEnum(body.category ?? "other", EMERGENCY_CATEGORIES.map((c) => c.value), "category");
  const candidates = await rankHospitals(pickup, category, 5);
  return ok({
    candidates: candidates.map((c) => ({
      hospitalId: c.hospital.id,
      code: c.hospital.code,
      name: c.hospital.name,
      address: c.hospital.address,
      city: c.hospital.city,
      phone: c.hospital.phone,
      emergencyLevel: c.hospital.emergencyLevel,
      traumaLevel: c.hospital.traumaLevel,
      facilities: c.hospital.facilities,
      verified: c.hospital.verified,
      durationSeconds: c.durationSeconds,
      distanceMeters: c.distanceMeters,
      suitability: c.suitability,
      missing: c.missing,
      matched: c.matched,
      traffic: c.option?.traffic ?? "moderate",
      disruptions: c.option?.disruptions ?? [],
    })),
  });
});
