import { ok, route } from "@/lib/api";
import { loadSegments } from "@/lib/dispatch";
import { roadGraphStatus } from "@/lib/roadGraph";

export const dynamic = "force-dynamic";

/** Road network diagnostics: the routing graph used for three options, and the connectivity of the segment set. */
export const GET = route(async () => {
  const segments = await loadSegments();
  const adjacency = new Map<string, Set<string>>();
  for (const segment of segments) {
    if (!adjacency.has(segment.startNode)) adjacency.set(segment.startNode, new Set());
    if (!adjacency.has(segment.endNode)) adjacency.set(segment.endNode, new Set());
    adjacency.get(segment.startNode)!.add(segment.endNode);
    adjacency.get(segment.endNode)!.add(segment.startNode);
  }

  const components: number[] = [];
  const visited = new Set<string>();
  for (const node of adjacency.keys()) {
    if (visited.has(node)) continue;
    let size = 0;
    const stack = [node];
    visited.add(node);
    while (stack.length > 0) {
      const current = stack.pop()!;
      size += 1;
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
    components.push(size);
  }
  components.sort((a, b) => b - a);

  return ok({
    routeGraph: roadGraphStatus(),
    demoSegments: {
      nodes: adjacency.size,
      edges: segments.length,
      components: components.length,
      largestComponentShare: adjacency.size > 0 ? Number(((components[0] ?? 0) / adjacency.size).toFixed(3)) : 0,
    },
  });
});
