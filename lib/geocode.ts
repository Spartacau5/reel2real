// Location enrichment via Google Places API (New) Text Search.
// See SPEC.md → Location Enrichment.
//
// For items that name a venue but have NO stated address, look up a verified
// address + a Google Maps link. A stated address (copied verbatim from the post
// per the Image Handling rule) is NEVER overridden — those are tagged
// address_source="stated" and left alone.
//
// Env: GOOGLE_MAPS_API_KEY. If unset, enrichment is a no-op (address_source is
// still set to "stated" for items that stated an address).
// Requires "Places API (New)" enabled + billing on the Google Cloud project.

import type { Item } from "./types";

const SEARCH_TEXT = "https://places.googleapis.com/v1/places:searchText";
const TIMEOUT_MS = 5_000;

// v1 is NYC-focused (see SPEC test cases). Bias Text Search toward NYC so a bare
// venue name ("Nando's") resolves to the NYC location, not a London flagship.
// This is a REQUEST parameter, not just prompt/spec guidance.
// TODO: derive the bias center from the post's city when the product expands
// beyond NYC (fall back to this default).
const NYC_LOCATION_BIAS = {
  circle: {
    // Central Manhattan (not City Hall) — keeps the bias off the NJ border so a
    // bare venue name resolves to NYC, not Jersey City. 40km covers all boroughs.
    center: { latitude: 40.7306, longitude: -73.9866 },
    radius: 40_000, // max allowed is 50km
  },
};

/** Enrich all items in parallel. */
export async function enrichLocations(items: Item[]): Promise<Item[]> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  return Promise.all(items.map((item) => enrichOne(item, key)));
}

async function enrichOne(item: Item, key: string | undefined): Promise<Item> {
  // Stated address wins — never override, never geocode.
  if (item.address && item.address.trim()) {
    return { ...item, address_source: "stated" };
  }

  // Need a venue to search on, and a key to search with.
  const venue = item.place_name || item.location;
  if (!venue || !key) return item; // leaves address_source = null (unresolved)

  try {
    const query = [item.place_name, item.location].filter(Boolean).join(", ");
    const res = await fetch(SEARCH_TEXT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.formattedAddress,places.id",
      },
      body: JSON.stringify({
        textQuery: query,
        maxResultCount: 1,
        locationBias: NYC_LOCATION_BIAS,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return item;

    const data = (await res.json()) as {
      places?: Array<{ formattedAddress?: string; id?: string }>;
    };
    const top = data.places?.[0];
    if (!top?.formattedAddress) return item;

    const q = encodeURIComponent(top.formattedAddress);
    const maps_url = top.id
      ? `https://www.google.com/maps/search/?api=1&query=${q}&query_place_id=${top.id}`
      : `https://www.google.com/maps/search/?api=1&query=${q}`;

    return {
      ...item,
      resolved_address: top.formattedAddress,
      maps_url,
      address_source: "resolved",
    };
  } catch {
    // Timeout / network / bad response — leave the item unenriched.
    return item;
  }
}
