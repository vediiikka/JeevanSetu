import { fail, ok, route } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Thin server-side proxy for reverse geocoding (keeps the browser off third-party rate limits). */
export const GET = route(async (request: Request) => {
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim();
  if (query) {
    if (query.length < 3) return ok({ results: [] });
    const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
    if (googleMapsApiKey) {
      const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": googleMapsApiKey,
          "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
        },
        body: JSON.stringify({
          textQuery: query,
          regionCode: "IN",
          languageCode: "en",
          maxResultCount: 5,
        }),
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      });
      if (!response.ok) {
        console.error("[geocode] Google Places search failed", response.status);
        return fail("Address search is temporarily unavailable. Check the Google Places API configuration.", 502);
      }
      const data = (await response.json()) as {
        places?: {
          displayName?: { text?: string };
          formattedAddress?: string;
          location?: { latitude?: number; longitude?: number };
        }[];
      };
      const results = (data.places ?? []).flatMap((place) => {
        const lat = place.location?.latitude;
        const lng = place.location?.longitude;
        const name = place.displayName?.text;
        const formattedAddress = place.formattedAddress;
        if (
          typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
          typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180 ||
          !name || !formattedAddress
        ) return [];
        return [{
          lat,
          lng,
          name,
          displayName: `${name}, ${formattedAddress}`,
          shortAddress: formattedAddress,
        }];
      });
      return ok({ results });
    }

    const searchUrl = new URL("https://nominatim.openstreetmap.org/search");
    searchUrl.search = new URLSearchParams({
      format: "jsonv2",
      addressdetails: "1",
      limit: "5",
      countrycodes: "in",
      q: query,
    }).toString();
    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent": "JeevanSetu-Emergency-Routing/1.0 (demo application)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!response.ok) return ok({ results: [], error: "Address search is temporarily unavailable." }, 502);
    const data = (await response.json()) as {
      lat: string;
      lon: string;
      display_name: string;
      address?: Record<string, string>;
    }[];
    const results = data.flatMap((item) => {
      const lat = Number(item.lat);
      const lng = Number(item.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !item.display_name) return [];
      const address = item.address ?? {};
      const parts = [
        address.road ?? address.pedestrian ?? address.neighbourhood,
        address.suburb ?? address.village ?? address.town ?? address.city,
        address.city_district ?? address.district,
        address.state,
      ].filter(Boolean);
      return [{
        lat,
        lng,
        name: item.display_name.split(",")[0],
        displayName: item.display_name,
        shortAddress: parts.length > 0 ? parts.join(", ") : item.display_name,
      }];
    });
    return ok({ results });
  }

  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return ok({ displayName: null });
  }
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
      { headers: { "User-Agent": "JeevanSetu-Emergency-Routing/1.0 (demo application)", Accept: "application/json" } },
    );
    if (!response.ok) return ok({ displayName: null });
    const data = (await response.json()) as { display_name?: string; address?: Record<string, string> };
    const address = data.address ?? {};
    const parts = [
      address.road ?? address.pedestrian ?? address.neighbourhood,
      address.suburb ?? address.village ?? address.town ?? address.city,
      address.city_district ?? address.district,
      address.state,
    ].filter(Boolean);
    return ok({
      displayName: data.display_name ?? null,
      shortAddress: parts.length > 0 ? parts.join(", ") : data.display_name ?? null,
    });
  } catch {
    return ok({ displayName: null, shortAddress: null });
  }
});
