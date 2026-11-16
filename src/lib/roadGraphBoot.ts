/**
 * Node-only start-up checks (road network and its background rebuild). Loaded by instrumentation.ts
 * only inside the Node.js runtime, so the edge runtime never sees these Node APIs.
 */
let graphBuildStarted = false;

/**
 * Makes sure the OpenStreetMap road network exists. If the file is missing (for example the project
 * was copied without the data folder), it is rebuilt in the background with scripts/build-road-graph.mjs.
 * Routing keeps working meanwhile through the road service, and switches to the full three-option
 * engine as soon as the file is ready. Set JEEVANSETU_AUTO_BUILD_GRAPH=0 to disable the rebuild.
 */
export async function ensureRoadGraph(): Promise<void> {
  const { existsSync } = await import("node:fs");
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const { loadRoadGraph, resetRoadGraphCache, roadGraphStatus } = await import("@/lib/roadGraph");

  if (loadRoadGraph()) {
    const status = roadGraphStatus();
    console.log(`[road-graph] loaded ${status.junctions} junctions, ${status.segments} road segments from ${status.file}`);
    return;
  }
  const status = roadGraphStatus();
  console.warn(`[road-graph] NOT LOADED: ${status.error}. Route options will be limited until it is available. ${status.fix}`);

  if (process.env.JEEVANSETU_AUTO_BUILD_GRAPH === "0" || graphBuildStarted) return;
  const script = path.resolve(process.cwd(), "scripts/build-road-graph.mjs");
  if (!existsSync(script)) {
    console.warn(`[road-graph] cannot rebuild automatically: ${script} is missing`);
    return;
  }
  graphBuildStarted = true;
  console.warn("[road-graph] building the road network from OpenStreetMap in the background (a few minutes, needs internet)…");
  const child = spawn(process.execPath, [script], { cwd: process.cwd(), stdio: "inherit" });
  child.on("exit", (code) => {
    graphBuildStarted = false;
    if (code === 0) {
      resetRoadGraphCache();
      console.log("[road-graph] ready — three-option routing is now active");
    } else {
      console.error(`[road-graph] rebuild failed (exit ${code}). Check the internet connection, then run: node scripts/build-road-graph.mjs`);
    }
  });
}
