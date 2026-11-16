export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startLiveTicker } = await import("@/lib/liveTicker");
  startLiveTicker(2000);
  try {
    const { ensureRoadGraph } = await import("@/lib/roadGraphBoot");
    await ensureRoadGraph();
  } catch (error) {
    console.error("[road-graph] start-up check failed", error);
  }
}
