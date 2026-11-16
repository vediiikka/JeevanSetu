"use client";

import { useEffect, useRef, useState } from "react";

export type LiveSnapshot = {
  generatedAt: string;
  ambulances: {
    id: number;
    code: string;
    type: string;
    status: string;
    lat: number;
    lng: number;
    driverName: string | null;
    hospitalId: number | null;
  }[];
  requests: {
    id: number;
    publicId: string;
    status: string;
    category: string;
    severity: string;
    etaMinutes: number | null;
    ambulanceId: number | null;
    hospitalId: number | null;
    pickupLat: number;
    pickupLng: number;
    createdAt: string;
  }[];
  disruptions: {
    id: number;
    title: string;
    type: string;
    severity: string;
    status: string;
    lat: number;
    lng: number;
    roadName: string | null;
  }[];
  trips: { id: number; requestId: number; status: string; ambulanceId: number; driverId: number }[];
};

/**
 * Live state channel. Uses Server-Sent Events (server push) with an automatic
 * polling fallback so the UI keeps working on proxies that buffer streams.
 */
export function useLiveSnapshot(enabled = true, pollMs = 4000) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const fallbackRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | null = null;
    let cancelled = false;

    const applySnapshot = (data: LiveSnapshot) => {
      if (cancelled) return;
      setSnapshot(data);
      setLastUpdated(new Date().toLocaleTimeString());
      setConnected(true);
    };

    const poll = async () => {
      try {
        const data = await api<LiveSnapshot>("/api/live");
        applySnapshot(data);
      } catch {
        /* ignore */
      }
    };

    if (typeof window !== "undefined" && "EventSource" in window) {
      source = new EventSource("/api/stream");
      source.addEventListener("ready", () => setConnected(true));
      source.addEventListener("snapshot", (event) => {
        try {
          applySnapshot(JSON.parse((event as MessageEvent).data) as LiveSnapshot);
        } catch {
          /* ignore malformed frame */
        }
      });
      source.onerror = () => {
        setConnected(false);
        // EventSource reconnects on its own; polling covers the gap.
        void poll();
      };
    } else {
      fallbackRef.current = setInterval(() => {
        void poll();
      }, pollMs);
    }

    return () => {
      cancelled = true;
      source?.close();
      if (fallbackRef.current) clearInterval(fallbackRef.current);
    };
  }, [enabled, pollMs]);

  return { snapshot, connected, lastUpdated };
}

const SESSION_TOKEN_KEY = "jeevansetu.session";
/** Kept in memory too, so the session works even where browser storage is blocked. */
let memoryToken: string | null = null;
const expiryListeners = new Set<() => void>();

/** Store (or clear) the session token issued at login. */
export function setSessionToken(token: string | null): void {
  memoryToken = token;
  if (typeof window === "undefined") return;
  try {
    if (token) {
      window.sessionStorage.setItem(SESSION_TOKEN_KEY, token);
      window.localStorage.setItem(SESSION_TOKEN_KEY, token);
    } else {
      window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
      window.localStorage.removeItem(SESSION_TOKEN_KEY);
    }
  } catch {
    /* storage blocked: the in-memory token and cookie still carry the session */
  }
}

export function sessionToken(): string | null {
  if (memoryToken) return memoryToken;
  if (typeof window === "undefined") return null;
  try {
    const stored = window.sessionStorage.getItem(SESSION_TOKEN_KEY) ?? window.localStorage.getItem(SESSION_TOKEN_KEY);
    if (stored) memoryToken = stored;
    return stored;
  } catch {
    return null;
  }
}

/** Called whenever the server rejects the session (401). Returns an unsubscribe. */
export function onSessionExpired(listener: () => void): () => void {
  expiryListeners.add(listener);
  return () => {
    expiryListeners.delete(listener);
  };
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(sessionToken() ? { Authorization: `Bearer ${sessionToken()}` } : {}),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
    signal: init?.signal ?? AbortSignal.timeout(20000),
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });
  if (response.status === 401 && !url.startsWith("/api/auth/login")) {
    setSessionToken(null);
    expiryListeners.forEach((listener) => listener());
    throw new Error("Your session has ended. Please sign in again.");
  }
  if (!response.ok) {
    throw new Error((data as { error?: string }).error ?? `Request failed (${response.status})`);
  }
  return data as T;
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
