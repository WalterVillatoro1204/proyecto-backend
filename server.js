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

/* ======================================================
🌎 AJUSTE DE ZONA HORARIA
====================================================== */
async function setTimezone() {
  try {
    await db.query("SET time_zone = '-06:00'");
    console.log("🕓 Zona horaria MySQL ajustada a UTC-6 (Guatemala)");
  } catch (err) {
    console.warn("⚠️ No se pudo fijar zona horaria:", err.message);
  }
}

/* ======================================================
🔄 FUNCIÓN: Verificar subastas finalizadas
====================================================== */
// ======================================================
// 🔄 FUNCIÓN: Verificar subastas finalizadas (revisado)
// ======================================================
async function checkEndedAuctions() {
  try {
    // Subastas activas vencidas (con 2s de tolerancia)
    const [rows] = await db.query(`
      SELECT id_auctions, title
      FROM auctions
      WHERE status = 'active'
        AND end_time <= (NOW() - INTERVAL 2 SECOND)
    `);

    if (!rows.length) return;

    for (const { id_auctions, title } of rows) {
      console.log(`⚙️ Procesando subasta vencida #${id_auctions} (${title})...`);

      // Asegurarse de no cerrar mientras llega una puja tardía
      const [recentBid] = await db.query(`
        SELECT MAX(bid_time) AS last_bid_time
        FROM bids
        WHERE id_auctions = ?;
      `, [id_auctions]);

      if (recentBid[0].last_bid_time) {
        const lastBidTime = new Date(recentBid[0].last_bid_time);
        const endTime = new Date(Date.now() - 1000);
        if (lastBidTime > endTime) {
          console.log(`⏳ Aplazando cierre de #${id_auctions}, hay puja muy reciente.`);
          continue; // espera al siguiente ciclo
        }
      }

      // Buscar la puja más alta
      const [winner] = await db.query(`
        SELECT b.id_users, b.bid_amount, u.username
        FROM bids b
        JOIN users u ON u.id_users = b.id_users
        WHERE b.id_auctions = ?
        ORDER BY b.bid_amount DESC, b.bid_time ASC
        LIMIT 1
      `, [id_auctions]);

      // Cerrar la subasta
      await db.query("UPDATE auctions SET status = 'ended' WHERE id_auctions = ?", [id_auctions]);

      if (winner.length > 0) {
        const { id_users, bid_amount, username } = winner[0];
        const formattedAmount = parseFloat(bid_amount).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });

        const message = `🏆 🎉 ¡Felicidades ${username}! Ganaste la subasta #${id_auctions} con una puja de $${formattedAmount}.`;

        await db.query(`
          INSERT INTO notifications (id_auction, id_user, message)
          SELECT ?, ?, ?
          FROM DUAL
          WHERE NOT EXISTS (
            SELECT 1 FROM notifications
            WHERE id_auction = ? AND id_user = ? AND message LIKE '🏆 %'
          )
        `, [id_auctions, id_users, message, id_auctions, id_users]);

        io.emit("auctionEnded", { id_auctions, winner: username, bid_amount });
        console.log(`🏁 Subasta #${id_auctions} finalizada. Ganador: ${username} ($${bid_amount})`);
      } else {
        const msg = `😢 Nadie ofertó en la subasta #${id_auctions}.`;
        await db.query(`
          INSERT INTO notifications (id_auction, id_user, message)
          SELECT ?, NULL, ?
          FROM DUAL
          WHERE NOT EXISTS (
            SELECT 1 FROM notifications
            WHERE id_auction = ? AND message LIKE '😢 %'
          )
        `, [id_auctions, msg, id_auctions]);
        io.emit("auctionEnded", { id_auctions, winner: null });
        console.log(`🚫 Subasta #${id_auctions} cerrada sin pujas.`);
      }
    }
  } catch (err) {
    console.error("❌ Error en checkEndedAuctions:", err.message);
  }
}

/* ======================================================
⚙️ CONFIGURACIÓN BASE
====================================================== */
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

/* ======================================================
🧩 RUTAS API
====================================================== */
app.use("/api/users", userRoutes);
app.use("/api/auctions", auctionRoutes(io));
app.use("/api/bids", bidRoutes);
app.use("/api/notifications", notificationRoutes);

/* ======================================================
🩺 HEALTH CHECK
====================================================== */
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

/* ======================================================
🔐 SOCKET.IO AUTH
====================================================== */
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

/* ======================================================
💬 EVENTOS DE PUJA (Socket)
====================================================== */
io.on("connection", (socket) => {
  socket.on("newBid", async (bidData) => {
    try {
      const { token, id_auctions, bid_amount } = bidData;
      if (!token) return socket.emit("errorBid", { message: "Token requerido." });

      let decoded;
      try { decoded = jwt.verify(token, secret); }
      catch { return socket.emit("errorBid", { message: "Token inválido o expirado." }); }

      const userId = decoded.id;
      const auctionId = Number(id_auctions);
      const amount = Number(bid_amount);

      if (!auctionId || isNaN(amount) || amount <= 0)
        return socket.emit("errorBid", { message: "Monto inválido." });

      // ▶ Obtener datos de la subasta
      const [auctionRows] = await db.query(
        "SELECT CAST(base_price AS DECIMAL(10,2)) AS base_price, end_time, status FROM auctions WHERE id_auctions = ?",
        [auctionId]
      );

      if (!auctionRows.length)
        return socket.emit("errorBid", { message: "Subasta no encontrada." });

      // 🔧 Asegurar conversión numérica exacta
      const basePrice = parseFloat(auctionRows[0].base_price || "0");
      const endTime = new Date(auctionRows[0].end_time);
      const now = new Date();

      if (auctionRows[0].status === "ended" || now >= endTime)
        return socket.emit("errorBid", { message: "La subasta ya ha finalizado." });

      // ▶ Obtener puja más alta actual
      const [maxRows] = await db.query(
        "SELECT bid_amount FROM bids WHERE id_auctions = ? ORDER BY bid_amount DESC LIMIT 1",
        [auctionId]
      );

      const highestBid = maxRows.length ? parseFloat(maxRows[0].bid_amount || 0) : 0;
      if (isNaN(basePrice) || isNaN(highestBid)) {
        console.warn(`⚠️ Error de datos numéricos en subasta #${auctionId}: base=${auctionRows[0].base_price}, max=${maxRows[0]?.bid_amount}`);
      }
      const threshold = Math.max(basePrice, highestBid);

      // ❌ Si la puja no supera el umbral
      if (amount <= threshold) {
        return socket.emit("errorBid", {
          message: `La puja mínima debe ser mayor a $${threshold.toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
          })}.`,
        });
      }

      // ✅ Registrar la puja
      await db.query(
        "INSERT INTO bids (id_auctions, id_users, bid_amount) VALUES (?, ?, ?)",
        [auctionId, userId, amount]
      );

      console.log(`✅ Puja registrada: ${decoded.username} -> #${auctionId} $${amount}`);

      // ▶ Obtener nueva puja máxima para actualizar frontend
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
        highestBid: parseFloat(highest[0]?.bid_amount ?? amount),
        highestBidUser: highest[0]?.username ?? decoded.username,
      });
    } catch (err) {
      console.error("❌ Error al registrar la puja:", err);
      socket.emit("errorBid", { message: "Error interno al registrar la puja." });
    }
  });
});

/* ======================================================
🚀 INICIAR SERVIDOR
====================================================== */
server.listen(PORT, async () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);

  await setTimezone(); // ✅ Ajustar zona horaria antes de iniciar cron

  try {
    const [rows] = await db.query("SELECT NOW() AS hora_servidor");
    console.log("🕒 Hora actual en MySQL:", rows[0].hora_servidor);
  } catch (err) {
    console.error("❌ Error al conectar con la DB:", err.message);
  }

  console.log("⏰ Iniciando cron job...");
  cron.schedule("*/10 * * * * *", checkEndedAuctions);
});
