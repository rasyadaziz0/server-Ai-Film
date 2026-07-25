import "dotenv/config";
import express from "express";
import cors from "cors";
import { jobsRouter } from "./routes/jobs.router";
import { telegramRouter } from "./routes/telegram.router";
import { aiRouter } from "./routes/ai.router";
import { secretsRouter } from "./routes/secrets.router";

const app = express();
const PORT = parseInt(process.env.PORT || "4000", 10);

// --- CORS: Only allow exact production Vercel domain ---
const allowedOrigins = (process.env.ALLOWED_ORIGIN || "http://localhost:3000,https://www.acadlabs.fun").split(",").map(s => s.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow no-origin requests (server-to-server, health checks)
    if (!origin) return callback(null, true);
    
    // Always allow localhost for local development & testing against production VPS
    if (origin.startsWith("http://localhost:")) return callback(null, true);
    
    // Match against ALLOWED_ORIGIN env var (supports comma-separated)
    if (allowedOrigins.includes(origin)) return callback(null, true);
    
    callback(new Error(`CORS: Origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
}));

app.use(express.json({ limit: "5mb" }));

// --- Health check ---
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// --- API Routes ---
app.use("/v1/jobs", jobsRouter);
app.use("/v1/telegram", telegramRouter);
app.use("/v1/ai", aiRouter);
app.use("/v1/studios", secretsRouter);

// --- Global error handler ---
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[API Error]", err);
  const status = err.statusCode || 500;
  res.status(status).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[ECS API] Listening on port ${PORT}`);
  console.log(`[ECS API] CORS allowed origin: ${allowedOrigins.join(", ")}`);
});

export default app;
