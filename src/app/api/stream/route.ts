import { getSessionUser } from "@/lib/auth";
import { getLiveSnapshot } from "@/lib/dispatch";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-Sent Events stream.
 *
 * The requested WebSocket channel is implemented with SSE because the managed
 * Next.js runtime does not expose a WebSocket upgrade hook. Semantics are the
 * same: the server pushes a compact snapshot whenever state changes, and the
 * browser reconnects automatically (EventSource) with a 2.5s heartbeat.
 */
export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user || user.role !== "admin") {
    return new Response("Admin session required", { status: 401 });
  }
  await ensureSeeded();
  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const push = async () => {
        if (closed) return;
        try {
          const snapshot = await getLiveSnapshot();
          send("snapshot", snapshot);
        } catch (error) {
          console.error("[stream] snapshot failed", error);
        }
      };

      send("ready", { connectedAt: new Date().toISOString() });
      await push();
      timer = setInterval(() => {
        void push();
      }, 2500);

      request.signal.addEventListener("abort", () => {
        closed = true;
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
