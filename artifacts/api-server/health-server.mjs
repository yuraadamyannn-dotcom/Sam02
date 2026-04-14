import express from "express";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const PORT = 8080;
const app = express();

app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "sam-bot",
    ts: Date.now(),
    uptime_s: Math.floor(process.uptime()),
  });
});

app.get("/ping", (_req, res) => {
  res.json({ pong: true, ts: Date.now() });
});

app.get("/health", (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: "ok",
    uptime_s: Math.floor(process.uptime()),
    memory_mb: Math.round(mem.rss / 1024 / 1024),
    ts: Date.now(),
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[health-server] listening on port ${PORT}`);
  console.log(`[health-server] /health /ping / — ready for cron-job.org`);
});
