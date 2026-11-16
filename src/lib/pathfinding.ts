/**
 * Shortest-path search on the road graph.
 *
 *  - Dijkstra: explores in order of travel time from the start (no heuristic).
 *  - A*:       the same search guided by a Euclidean heuristic toward the destination.
 *              The heuristic is the straight-line (equirectangular Euclidean) distance divided by
 *              the highest possible road speed. It never overestimates the remaining time, so A*
 *              returns the same optimal time as Dijkstra while expanding fewer junctions.
 *
 * Several start points and several end points are supported, because a patient or ambulance
 * position is connected to the nearest few junctions (with a walking-free connector time).
 */

export type SearchAlgorithm = "dijkstra" | "astar";

export type SearchGraph = {
  nodeCount: number;
  nodeLng: Float64Array;
  nodeLat: Float64Array;
  edgeA: Int32Array;
  edgeB: Int32Array;
  outStart: Int32Array;
  outEdge: Int32Array;
  outDir: Uint8Array; // 0 = traverse edge from A to B, 1 = from B to A
};

export type Terminal = { node: number; cost: number };

export type SearchResult = {
  found: boolean;
  /** Total cost in seconds: start connector + road travel + end connector. */
  cost: number;
  steps: { edge: number; dir: 0 | 1 }[];
  startNode: number;
  endNode: number;
  /** Junctions taken off the queue (work done by the algorithm). */
  expanded: number;
  ms: number;
  algorithm: SearchAlgorithm;
};

/** Upper bound for road speed (90 km/h). Heuristic must be divided by this to stay admissible. */
export const MAX_SPEED_MPS = 25;
/** The heuristic is scaled slightly down so projection error can never make it overestimate. */
const HEURISTIC_SAFETY = 0.99;

/** Binary min-heap keyed by a number, carrying an integer payload. */
export class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    const keys = this.keys;
    const vals = this.vals;
    let i = keys.length;
    keys.push(key);
    vals.push(val);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      vals[i] = vals[parent];
      i = parent;
    }
    keys[i] = key;
    vals[i] = val;
  }

  pop(): { key: number; val: number } | null {
    const keys = this.keys;
    const vals = this.vals;
    const n = keys.length;
    if (n === 0) return null;
    const topKey = keys[0];
    const topVal = vals[0];
    const lastKey = keys.pop() as number;
    const lastVal = vals.pop() as number;
    const m = n - 1;
    if (m > 0) {
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        if (left >= m) break;
        const right = left + 1;
        const child = right < m && keys[right] < keys[left] ? right : left;
        if (keys[child] >= lastKey) break;
        keys[i] = keys[child];
        vals[i] = vals[child];
        i = child;
      }
      keys[i] = lastKey;
      vals[i] = lastVal;
    }
    return { key: topKey, val: topVal };
  }
}

/** Equirectangular Euclidean distance (metres) from a point to a node, used as the A* heuristic. */
function euclideanMeters(g: SearchGraph, node: number, lng: number, lat: number, cosLat: number): number {
  const dx = (g.nodeLng[node] - lng) * 111_320 * cosLat;
  const dy = (g.nodeLat[node] - lat) * 110_574;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Finds the cheapest route from any start terminal to any end terminal.
 *
 * `edgeTime[e]` is the travel time (seconds) of edge e in both directions, or Infinity when the
 * edge is closed. Penalties for alternative routes are applied by the caller through this array.
 */
export function shortestPath(
  g: SearchGraph,
  edgeTime: Float64Array,
  sources: Terminal[],
  targets: Terminal[],
  algorithm: SearchAlgorithm,
  goal: { lng: number; lat: number } | null,
): SearchResult {
  const started = performance.now();
  const n = g.nodeCount;
  const dist = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const prevEdge = new Int32Array(n).fill(-1);
  const prevDir = new Uint8Array(n);
  const prevNode = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const tail = new Float64Array(n).fill(Number.POSITIVE_INFINITY);

  for (const t of targets) if (t.cost < tail[t.node]) tail[t.node] = t.cost;

  const useHeuristic = algorithm === "astar" && goal !== null;
  const cosLat = goal ? Math.cos((goal.lat * Math.PI) / 180) : 1;
  const heuristic = (node: number): number => {
    if (!useHeuristic || !goal) return 0;
    return (HEURISTIC_SAFETY * euclideanMeters(g, node, goal.lng, goal.lat, cosLat)) / MAX_SPEED_MPS;
  };

  const heap = new MinHeap();
  for (const s of sources) {
    if (s.cost < dist[s.node]) {
      dist[s.node] = s.cost;
      heap.push(s.cost + heuristic(s.node), s.node);
    }
  }

  let bestTotal = Number.POSITIVE_INFINITY;
  let bestNode = -1;
  let expanded = 0;

  for (;;) {
    const item = heap.pop();
    if (!item) break;
    const node = item.val;
    if (closed[node]) continue;
    closed[node] = 1;
    expanded += 1;
    // Every remaining queue entry has f >= this key, so no later path can beat bestTotal.
    if (item.key >= bestTotal) break;

    const g0 = dist[node];
    if (tail[node] !== Number.POSITIVE_INFINITY) {
      const total = g0 + tail[node];
      if (total < bestTotal) {
        bestTotal = total;
        bestNode = node;
      }
    }

    for (let idx = g.outStart[node]; idx < g.outStart[node + 1]; idx += 1) {
      const edge = g.outEdge[idx];
      const time = edgeTime[edge];
      if (time === Number.POSITIVE_INFINITY) continue;
      const dir = g.outDir[idx];
      const to = dir === 0 ? g.edgeB[edge] : g.edgeA[edge];
      if (closed[to]) continue;
      const candidate = g0 + time;
      if (candidate < dist[to]) {
        dist[to] = candidate;
        prevEdge[to] = edge;
        prevDir[to] = dir;
        prevNode[to] = node;
        heap.push(candidate + heuristic(to), to);
      }
    }
  }

  const ms = performance.now() - started;
  if (bestNode < 0) {
    return { found: false, cost: Number.POSITIVE_INFINITY, steps: [], startNode: -1, endNode: -1, expanded, ms, algorithm };
  }

  const steps: { edge: number; dir: 0 | 1 }[] = [];
  let cursor = bestNode;
  while (prevEdge[cursor] !== -1) {
    steps.push({ edge: prevEdge[cursor], dir: prevDir[cursor] as 0 | 1 });
    cursor = prevNode[cursor];
  }
  steps.reverse();
  return {
    found: true,
    cost: bestTotal,
    steps,
    startNode: cursor,
    endNode: bestNode,
    expanded,
    ms,
    algorithm,
  };
}
