
import "dotenv/config";

import express from "express";
import cors from "cors";
import http from "node:http";
import { Server } from "socket.io";

import { connectDB } from "./config/db.js";
import { socketAuth } from "./middleware/socketAuth.js";
import { registerChatHandlers } from "./handlers/chatHandler.js";
import { registerCallHandlers } from "./handlers/callHandler.js";
import { registerGroupCallHandlers } from "./handlers/groupCallHandler.js";

const app = express();
const PORT = Number(process.env.PORT || 5001);

const allowedOrigins = [
  process.env.FRONTEND_URL || "http://localhost:5173",
  process.env.ADMIN_URL || "http://localhost:5174",
];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    service: "company-portal-socket",
  });
});

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
  maxHttpBufferSize: 1000000,
});

io.use(socketAuth);

io.on("connection", (socket) => {
  const userId = String(socket.data.user.id);

  // Personal room used by incoming calls.
  socket.join(`user:${userId}`);

  console.log(
    `Socket connected: ${userId} (${socket.id})`
  );

  registerChatHandlers(io, socket);
  registerCallHandlers(io, socket);
  registerGroupCallHandlers(io, socket);

  socket.on("disconnect", (reason) => {
    console.log(
      `Socket disconnected: ${userId} (${reason})`
    );
  });
});

async function start() {
  try {
    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET is missing");
    }

    await connectDB();

    httpServer.listen(PORT, () => {
      console.log(
        `Socket server running at http://localhost:${PORT}`
      );
    });
  } catch (error) {
    console.error("Socket server startup failed:", error);
    process.exit(1);
  }
}

start();
