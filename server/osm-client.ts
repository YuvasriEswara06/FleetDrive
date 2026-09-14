/**
 * OpenStreetMap & OSRM Routing Client
 * 
 * Provides:
 * 1. Live Geocoding via Nominatim API
 * 2. Live Road Distance & Duration Matrix via OSRM API
 * 3. Live Road Polyline Geometry via OSRM Route API
 * 4. Deterministic Offline Haversine Fallback for 100% demo safety
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RoadMatrixResult {
  distances: number[][]; // Distance in meters between [i][j]
  durations: number[][]; // Duration in seconds between [i][j]
  source: "osrm_live" | "haversine_fallback";
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
}

// Fallback coordinates for key Chennai hubs if offline
const CHENNAI_OFFLINE_CACHE: Record<string, LatLng> = {
  teynampet: { lat: 13.0382, lng: 80.2466 },
  "anna nagar": { lat: 13.085, lng: 80.2101 },
  "besant nagar": { lat: 13.0002, lng: 80.2668 },
  velachery: { lat: 12.9815, lng: 80.218 },
  mylapore: { lat: 13.0339, lng: 80.2676 },
  omr: { lat: 12.9348, lng: 80.2312 },
  thoraipakkam: { lat: 12.9348, lng: 80.2312 },
  "t. nagar": { lat: 13.0418, lng: 80.2341 },
  guindy: { lat: 13.0067, lng: 80.203 },
  adyar: { lat: 13.0012, lng: 80.2565 },
};

/**
 * Calculates mathematical great-circle distance between two coordinates in meters
 */
export function haversineDistanceMeters(p1: LatLng, p2: LatLng): number {
  const R = 6371000; // Earth radius in meters
  const dLat = ((p2.lat - p1.lat) * Math.PI) / 180;
  const dLon = ((p2.lng - p1.lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((p1.lat * Math.PI) / 180) *
      Math.cos((p2.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Geocodes an address string using OpenStreetMap Nominatim API
 * With built-in fallback cache
 */
export async function geocodeAddress(query: string): Promise<GeocodeResult> {
  const trimmed = query.trim().toLowerCase();

  // Check offline dictionary first
  for (const [key, coords] of Object.entries(CHENNAI_OFFLINE_CACHE)) {
    if (trimmed.includes(key)) {
      return {
        lat: coords.lat,
        lng: coords.lng,
        displayName: query,
      };
    }
  }

  // Try live OSM Nominatim
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      query + ", Chennai, Tamil Nadu, India"
    )}&format=json&limit=1`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3s timeout

    const res = await fetch(url, {
      headers: {
        "User-Agent": "FleetDrive-Academic-Project/1.0 (contact: support@fleetdrive.local)",
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      if (data && data.length > 0) {
        return {
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon),
          displayName: data[0].display_name,
        };
      }
    }
  } catch (e) {
    console.warn("[OSM Geocode] Live Nominatim query failed or timed out, using fallback:", e);
  }

  // Default to central Chennai (Mylapore) if unknown
  return {
    lat: 13.0339,
    lng: 80.2676,
    displayName: query,
  };
}

/**
 * Computes pairwise road driving distance & duration matrix
 * Uses OSRM live routing server with automatic Haversine fallback
 */
export async function getRoadMatrix(points: LatLng[]): Promise<RoadMatrixResult> {
  const n = points.length;
  if (n <= 1) {
    return {
      distances: [[0]],
      durations: [[0]],
      source: "haversine_fallback",
    };
  }

  // Try live OSRM table API
  try {
    const coordString = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const url = `https://router.project-osrm.org/table/v1/driving/${coordString}?annotations=distance,duration`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500); // 2.5s fast timeout

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      if (data.code === "Ok" && data.distances && data.durations) {
        return {
          distances: data.distances,
          durations: data.durations,
          source: "osrm_live",
        };
      }
    }
  } catch (e) {
    // Expected when offline or when OSRM is slow
  }

  // Fallback: Mathematical Haversine with 1.25x urban road tortuosity factor
  // Average Chennai city speed: 25 km/h (6.94 m/s)
  const distances: number[][] = [];
  const durations: number[][] = [];
  const URBAN_ROAD_FACTOR = 1.25;
  const SPEED_MPS = 25 * (1000 / 3600); // 6.94 m/s

  for (let i = 0; i < n; i++) {
    distances[i] = [];
    durations[i] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) {
        distances[i][j] = 0;
        durations[i][j] = 0;
      } else {
        const straightMeters = haversineDistanceMeters(points[i], points[j]);
        const roadMeters = Math.round(straightMeters * URBAN_ROAD_FACTOR);
        const durationSec = Math.round(roadMeters / SPEED_MPS);
        distances[i][j] = roadMeters;
        durations[i][j] = durationSec;
      }
    }
  }

  return {
    distances,
    durations,
    source: "haversine_fallback",
  };
}

/**
 * Retrieves the road-following polyline coordinates for Leaflet rendering
 * Returns array of [lat, lng]
 */
export async function getRoadPolyline(points: LatLng[]): Promise<Array<[number, number]>> {
  if (points.length < 2) {
    return points.map((p) => [p.lat, p.lng]);
  }

  try {
    const coordString = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const url = `https://router.project-osrm.org/route/v1/driving/${coordString}?overview=full&geometries=geojson`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      if (data.code === "Ok" && data.routes && data.routes.length > 0) {
        // OSRM GeoJSON gives [lng, lat], convert to Leaflet's [lat, lng]
        const rawCoords: number[][] = data.routes[0].geometry.coordinates;
        return rawCoords.map(([lng, lat]) => [lat, lng]);
      }
    }
  } catch (e) {
    // Fallback below
  }

  // Fallback: Return straight lines connecting points
  return points.map((p) => [p.lat, p.lng]);
}
