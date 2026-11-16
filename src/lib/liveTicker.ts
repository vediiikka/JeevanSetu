import { advanceActiveAmbulances } from "@/lib/dispatch";

type TickerGlobal = typeof globalThis & { __jeevansetuLiveTicker?: ReturnType<typeof setInterval> };

/**
 * Server-side movement clock. Ambulances move, and pickup / hospital hand-offs happen, on
 * this timer even when no dashboard is open. Started once per server process.
 */
export function startLiveTicker(intervalMs = 2000): void {
  const g = globalThis as TickerGlobal;
  if (g.__jeevansetuLiveTicker) return;
  g.__jeevansetuLiveTicker = setInterval(() => {
    advanceActiveAmbulances().catch((error) => {
      console.error("[live-ticker] movement engine failed", error);
    });
  }, intervalMs);
}
