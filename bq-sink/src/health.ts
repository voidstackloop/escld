import { createServer, type Server } from "node:http";

export interface WorkerStats {
  jobsSucceeded: number;
  jobsFailed: number;
  jobsQuarantined: number;
  canonicalizationsSucceeded: number;
  canonicalizationsFailed: number;
  lastCanonicalizedAt: string | null;
  startedAt: string;
}

/** Minimal liveness endpoint + counters — enough for a container orchestrator's
 * health check and a quick `curl` during an incident, without pulling in a
 * full metrics client library. */
export function startHealthServer(port: number, isShuttingDown: () => boolean, stats: WorkerStats): Server {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      if (isShuttingDown()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "shutting_down" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          ...stats,
          uptimeSeconds: process.uptime(),
        })
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port);
  return server;
}
