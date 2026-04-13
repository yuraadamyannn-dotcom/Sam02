import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { getLastHealthReport } from "./bot/monitor";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Root-level health endpoints for cron-job.org and external monitors
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "sam-bot", ts: Date.now() });
});
app.get("/ping", (_req, res) => {
  res.json({ status: "ok", ts: Date.now() });
});
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: Math.floor(process.uptime()), ts: Date.now() });
});

// Agent status endpoint for external monitoring services
app.get("/agent/status", (_req, res) => {
  const report = getLastHealthReport();
  const mem = process.memoryUsage();
  if (report) {
    res.json({ ...report, node_version: process.version });
  } else {
    res.json({
      status: "ok",
      uptime_seconds: Math.floor(process.uptime()),
      memory: {
        heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        external_mb: Math.round(mem.external / 1024 / 1024),
      },
      node_version: process.version,
      note: "Monitor not yet run (starting soon)",
      ts: Date.now(),
    });
  }
});

app.use("/api", router);

export default app;
