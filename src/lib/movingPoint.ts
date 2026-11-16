"use client";

import { useEffect, useState } from "react";
import { bearing, pointAlongPolyline, polylineLength, type LatLng } from "@/lib/geo";

export type { LatLng };

export type VehiclePose = {
  position: LatLng;
  heading: number;
  progress: number;
  speedKph: number;
  remainingMeters: number;
  remainingSeconds: number;
};

/**
 * Computes the vehicle pose at an arbitrary instant.
 *
 * The server stores the route geometry, the progress at `updatedAt` and the
 * route duration, so the exact position at any later time can be derived by
 * walking the polyline — the same way a navigation app interpolates between
 * GPS fixes. Movement therefore follows the road, not a straight line.
 */
export function computeVehiclePose(
  geometry: [number, number][] | null | undefined,
  progress: number,
  durationSeconds: number | null,
  updatedAt: string | null,
  now = Date.now(),
): VehiclePose | null {
  if (!geometry || geometry.length < 2) return null;
  const line = geometry.map(([lng, lat]) => ({ lat, lng }));
  const total = polylineLength(line);
  if (total <= 0) return null;

  const elapsed = updatedAt ? Math.max(0, (now - new Date(updatedAt).getTime()) / 1000) : 0;
  const duration = durationSeconds && durationSeconds > 0 ? durationSeconds : 0;
  const nextProgress = Math.max(0, Math.min(1, progress + (duration > 0 ? elapsed / duration : 0)));

  const position = pointAlongPolyline(line, nextProgress * total);
  const ahead = pointAlongPolyline(line, Math.min(total, nextProgress * total + 30));
  const heading = bearing(position, ahead);
  const speedKph = duration > 0 ? (total / duration) * 3.6 : 0;

  return {
    position,
    heading,
    progress: nextProgress,
    speedKph,
    remainingMeters: Math.max(0, total * (1 - nextProgress)),
    remainingSeconds: Math.max(0, duration * (1 - nextProgress)),
  };
}

/** React hook version (used outside the map, e.g. for numeric read-outs). */
export function useVehiclePose(
  geometry: [number, number][] | null | undefined,
  progress: number,
  durationSeconds: number | null,
  updatedAt: string | null,
  intervalMs = 500,
): VehiclePose | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return computeVehiclePose(geometry, progress, durationSeconds, updatedAt, now);
}

/** Point at `progress` (0..1) along a GeoJSON LineString. */
export function positionAlong(
  geometry: [number, number][] | null | undefined,
  progress: number,
): LatLng | null {
  if (!geometry || geometry.length < 2) return null;
  const line = geometry.map(([lng, lat]) => ({ lat, lng }));
  return pointAlongPolyline(line, Math.max(0, Math.min(1, progress)) * polylineLength(line));
}

/** Remaining road distance and ETA for the current progress. */
export function remainingAlong(
  geometry: [number, number][] | null | undefined,
  progress: number,
  durationSeconds: number | null,
): { meters: number; seconds: number } | null {
  if (!geometry || geometry.length < 2) return null;
  const line = geometry.map(([lng, lat]) => ({ lat, lng }));
  const total = polylineLength(line);
  const meters = Math.max(0, total * (1 - Math.max(0, Math.min(1, progress))));
  const seconds = durationSeconds ? Math.max(0, durationSeconds * (1 - progress)) : 0;
  return { meters, seconds };
}

/** Compass heading of the route at the current progress. */
export function headingAlong(geometry: [number, number][] | null | undefined, progress: number): number {
  if (!geometry || geometry.length < 2) return 0;
  const clamped = Math.max(0, Math.min(1, progress));
  const index = Math.min(geometry.length - 2, Math.floor(clamped * (geometry.length - 1)));
  const [lng1, lat1] = geometry[index];
  const [lng2, lat2] = geometry[index + 1];
  return bearing({ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 });
}
