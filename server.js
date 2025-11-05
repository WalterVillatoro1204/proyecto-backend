import express from "express";
import cors from "cors";
import { db } from "./db.js";
import userRoutes from "./routes/users.js";
import auctionRoutes from "./routes/auctions.js";
import bidRoutes from "./routes/bids.js";
import http from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import cron from "node-cron";
import notificationRoutes from "./routes/notifications.js";

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 8080;
const secret = process.env.JWT_SECRET;

// ======================================================
// 🔄 FUNCIÓN: Verificar subastas finalizadas
// ======================================================
async function checkEndedAuctions() {
  try {
    const [tz] = await db.query(
      "SELECT NOW() AS mysql_now, UTC_TIMESTAMP() AS mysql_utc"
    );
    console.log(
      "🕒 MySQL NOW:",
      tz[0].mysql_now,
      "| MySQL UTC:",
      tz[0].mysql_utc,
      "| Node:",
      new Date().toISOString()
    );

    // ✅ Buscar subastas activas que ya terminaron
    const [rows] = await db.query(`
      SELECT a.id_auctions, a.title
      FROM auctions a
      WHERE a.end_time <= NOW()
      AND a.status = 'active'
    `);

    if (!rows.length) return;

    for (const auction of rows) {
      const auctionId = auction.id_auctions;
      console.log(`⚙️ Procesando subasta finalizada #${auctionId} (${auction.title})...`);

      // 🥇 Buscar la puja más alta
      const [winner] = await db.query(
        `SELECT b.id_users, b.bid_amount, u.username
         FROM bids b
         JOIN users u ON u.id_users = b.id_users
         WHERE b.id_auctions = ?
         ORDER BY b.bid_amount DESC, b.bid_time ASC
         LIMIT 1`,
        [auctionId]
      );

      // 🔒 Cerrar la subasta
      await db.query(
        `UPDATE auctions SET status = 'ended' WHERE id_auctions = ?`,
        [auctionId]
      );

      // 🏆 Si hay ganador
      if (winner.length > 0) {
        const { id_users, bid_amount, username } = winner[0];

        await db.query(
          `INSERT INTO notifications (id_auction, id_user, message)
           SELECT ?, ?, ?
           FROM DUAL
           WHERE NOT EXISTS (
             SELECT 1 FROM notifications
             WHERE id_auction = ? AND id_user = ? AND message LIKE '🏆 %'
           )`,
          [
            auctionId,
            id_users,
            `🏆 🎉 ¡Felicidades ${username}! Ganaste la subasta #${auctionId} con una puja de $${bid_amount.toLocaleString(
              "en-US"
            )}.`,
            auctionId,
            id_users,
          ]
        );

        io.emit("auctionEnded", {
          id_auctions: auctionId,
          winner: username,
          bid_amount,
        });

        console.log(`✅ Subasta #${auctionId} finalizada. Ganador: ${username} ($${bid_amount})`);
      } else {
        // 😢 Sin pujas
        await db.query(
          `INSERT INTO notifications (id_auction, id_user, message)
           SELECT ?, NULL, ?
           FROM DUAL
           WHERE NOT EXISTS (
             SELECT 1 FROM notifications
             WHERE id_auction = ? AND message LIKE '😢 %'
           )`,
          [
            auctionId,
            `😢 Nadie ofertó en la subasta #${auctionId}.`,
            auctionId,
          ]
        );

        io.emit("auctionEnded", { id_auctions: auctionId, winner: null });
        console.log(`🚫 Subasta #${auctionId} cerrada sin pujas.`);
      }
    }
  } catch (err) {
    console.error("❌ Error en checkEndedAuctions:", err.message);
  }
}

// Ejecutar cada 10 segundos
cron.schedule("*/10 * * * * *", checkEndedAuctions);

// ======================================================
// ⚙️ CONFIGURACIÓN BASE
// ======================================================
app.use(express.json());
app.use(cors({
  origin: [
    "https://www.mycarbid.click",
    "https://mycarbid.click",
    "https://main.d3rcj7yl7zv9wm.amplifyapp.com"
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ======================================================
// 🧩 RUTAS API
// ======================================================
app.use("/api/users", userRoutes);
app.use("/api/auctions", auctionRoutes(io));
app.use("/api/bids", bidRoutes);
app.use("/api/notifications", notificationRoutes);

// ======================================================
// 🩺 HEALTH CHECK
// ======================================================
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// ======================================================
// 🧠 VERIFICAR CONEXIÓN A BD
// ======================================================
app.get("/", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT NOW() AS time");
    return res.status(200).json({ ok: true, db_time: rows[0].time });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ======================================================
// 🔐 SOCKET.IO AUTH
// ======================================================
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    if (!token) {
      console.log("⚠️ Cliente conectado sin token (modo visitante)");
      socket.username = "visitante";
      return next();
    }

    const decoded = jwt.verify(token, secret);
    socket.userId = decoded.id;
    socket.username = decoded.username;
    socket.join(`user_${decoded.id}`);
    console.log(`✅ Usuario autenticado en WebSocket: ${socket.username}`);
    next();
  } catch (err) {
    console.error("❌ Token inválido:", err.message);
    return next(new Error("Token inválido"));
  }
});

// ======================================================
// 💬 EVENTOS DE PUJA (Socket)
// ======================================================
io.on("connection", (socket) => {
  socket.on("newBid", async (bidData) => {
    console.log("📩 NUEVA PUJA RECIBIDA:", bidData);

    try {
      const { token, id_auctions, bid_amount } = bidData;
      if (!token) return socket.emit("errorBid", { message: "Token requerido" });

      // Verificar token
      let decoded;
      try {
        decoded = jwt.verify(token, secret);
      } catch {
        return socket.emit("errorBid", { message: "Token inválido o expirado" });
      }

      const userId = decoded.id;
      const auctionId = Number(id_auctions);
      const amount = Number(bid_amount);

      if (!auctionId || isNaN(amount) || amount <= 0)
        return socket.emit("errorBid", { message: "Monto inválido." });

      // Datos de la subasta
      const [auctionRows] = await db.query(
        `SELECT base_price, end_time, status FROM auctions WHERE id_auctions = ?`,
        [auctionId]
      );
      if (!auctionRows.length)
        return socket.emit("errorBid", { message: "Subasta no encontrada." });

      const basePrice = parseFloat(auctionRows[0].base_price);
      const endTime = new Date(auctionRows[0].end_time);

      if (auctionRows[0].status === "ended" || new Date() >= endTime)
        return socket.emit("errorBid", { message: "La subasta ya ha finalizado." });

      // Puja más alta actual
      const [maxRows] = await db.query(
        `SELECT bid_amount FROM bids WHERE id_auctions = ? ORDER BY bid_amount DESC LIMIT 1`,
        [auctionId]
      );
      const highestBid = maxRows.length ? parseFloat(maxRows[0].bid_amount) : 0;

      // Umbral correcto (mayor entre base y actual)
      const threshold = Math.max(basePrice, highestBid);

      if (amount <= threshold)
        return socket.emit("errorBid", {
          message: `La puja mínima debe ser mayor a $${threshold.toFixed(2)}`
        });

      // Insertar puja
      await db.query(
        "INSERT INTO bids (id_auctions, id_users, bid_amount) VALUES (?, ?, ?)",
        [auctionId, userId, amount]
      );

      console.log(`✅ Puja registrada: ${decoded.username} -> #${auctionId} $${amount}`);

      // Emitir actualización
      const [highest] = await db.query(
        `SELECT b.bid_amount, u.username
         FROM bids b
         JOIN users u ON u.id_users = b.id_users
         WHERE b.id_auctions = ?
         ORDER BY b.bid_amount DESC, b.bid_time ASC
         LIMIT 1`,
        [auctionId]
      );

      io.emit("updateBids", {
        id_auctions: auctionId,
        highestBid: highest[0]?.bid_amount ?? amount,
        highestBidUser: highest[0]?.username ?? decoded.username
      });
    } catch (err) {
      console.error("❌ Error al registrar la puja:", err);
      socket.emit("errorBid", { message: "Error interno al registrar la puja" });
    }
  });
});

// ======================================================
// 🚀 INICIAR SERVIDOR
// ======================================================
server.listen(PORT, async () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);

  try {
    const [rows] = await db.query("SELECT NOW() AS hora_servidor");
    console.log("🕒 Hora actual en MySQL:", rows[0].hora_servidor);
  } catch (err) {
    console.error("❌ Error al conectar con la DB:", err.message);
  }

  console.log("⏰ Iniciando cron job...");
  cron.schedule("*/10 * * * * *", checkEndedAuctions);
});