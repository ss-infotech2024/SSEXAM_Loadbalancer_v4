import dns from "dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);

import cluster from "node:cluster";
import os from "node:os";
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import connectDB from "./config/db.js";

import authRoutes from "./routes/authRoutes.js";
import superAdminRoutes from "./routes/superRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import studentRoutes from "./routes/studentRoutes.js";
import studentExamRoutes from "./routes/examRoutes.js";
import examAttemptroutes from "./routes/examattemptroutes.js";
import qrScanRoutes from "./routes/qrScanRoutes.js";
import registrationRoutes from "./routes/registrationRoutes.js";
import departmentRoutes from "./routes/departmentRoutes.js";
import questionLibraryRoutes from "./routes/questionLibraryRoutes.js";

dotenv.config();

const PORT = Number(process.env.PORT) || 5000;
const CPU_COUNT =
  typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;

// By default, start up to 2 workers so the app can use more than one CPU
// without opening an unnecessarily large number of MongoDB connections.
// You can change this with CLUSTER_WORKERS in .env.
const configuredWorkers = Number.parseInt(process.env.CLUSTER_WORKERS ?? "", 10);
const WORKER_COUNT =
  Number.isInteger(configuredWorkers) && configuredWorkers > 0
    ? configuredWorkers
    : Math.min(2, Math.max(1, CPU_COUNT));

function createApp() {
  const app = express();

  const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",

  "https://ssexam.ssinfotech.co.in",
  "http://ssexam.ssinfotech.co.in",
  "https://www.ssexam.ssinfotech.co.in",
  "http://www.ssexam.ssinfotech.co.in",

  "https://ss-exam-psi.vercel.app",
  "https://ss-exam-portal.netlify.app",
  "https://exam.ssinfotech.co.in",
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests without Origin
      // e.g. Postman/server-to-server requests
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.warn("Blocked CORS origin:", origin);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },

    credentials: true,

    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "Origin",
      "X-Requested-With",
    ],

    optionsSuccessStatus: 204,
  })
);

  // Middleware
  app.use(express.json());

  // Routes
  app.use("/api/auth", authRoutes);
  app.use("/api/superadmin", superAdminRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/student", studentRoutes);
  app.use("/api/student", studentExamRoutes);
  app.use("/api", examAttemptroutes);
  app.use("/api/admin/qr-scanner", qrScanRoutes);
  app.use("/api/admin/question-library", questionLibraryRoutes);
  app.use("/api/departments", departmentRoutes);
  app.use("/api/student-registration", registrationRoutes);

  // Health check (VERY IMPORTANT for Render)
  app.get("/", (req, res) => {
    res.send("API is running 🚀");
  });

  // Optional endpoint to verify that requests are reaching different workers.
  // Example response: { status: "ok", workerId: 1, pid: 12345 }
  app.get("/api/load-balancer-health", (req, res) => {
    res.json({
      status: "ok",
      workerId: cluster.worker?.id ?? null,
      pid: process.pid,
    });
  });

  // Error handling
  app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ message: err.message });
  });

  return app;
}

if (cluster.isPrimary) {
  // Explicitly use round-robin scheduling for incoming connections.
  cluster.schedulingPolicy = cluster.SCHED_RR;

  let shuttingDown = false;

  console.log(`Primary process ${process.pid} started.`);
  console.log(`Load balancing enabled with ${WORKER_COUNT} worker(s).`);
  console.log(`Listening on port ${PORT}.`);

  for (let i = 0; i < WORKER_COUNT; i += 1) {
    cluster.fork();
  }

  cluster.on("online", (worker) => {
    console.log(`Worker ${worker.id} is online (PID ${worker.process.pid}).`);
  });

  // Replace a worker if it exits unexpectedly.
  cluster.on("exit", (worker, code, signal) => {
    console.warn(
      `Worker ${worker.id} (PID ${worker.process.pid}) exited. ` +
        `code=${code}, signal=${signal ?? "none"}.`
    );

    if (!shuttingDown) {
      const replacement = cluster.fork();
      console.log(
        `Started replacement worker ${replacement.id} ` +
          `(PID ${replacement.process.pid}).`
      );
    }
  });

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`Primary received ${signal}. Shutting down workers...`);

    for (const worker of Object.values(cluster.workers)) {
      worker?.disconnect();
    }

    setTimeout(() => {
      for (const worker of Object.values(cluster.workers)) {
        worker?.kill();
      }
      process.exit(0);
    }, 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
} else {
  const app = createApp();

  // Each worker maintains its own MongoDB connection pool.
  // All workers share the same listening port through Node's cluster module.
  connectDB();

  const server = app.listen(PORT, () => {
    console.log(
      `Worker ${cluster.worker.id} (PID ${process.pid}) is listening on port ${PORT}.`
    );
  });

  const shutdown = (signal) => {
    console.log(`Worker ${cluster.worker.id} received ${signal}. Closing server...`);

    server.close(() => {
      process.exit(0);
    });

    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
