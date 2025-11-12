// ==============================================
//  SERVER.JS - CORREGIDO Y OPTIMIZADO
// ==============================================

import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import cron from "node-cron";
import { DateTime } from "luxon";
import { db } from "./db.js";

// Rutas
import userRoutes from "./routes/users.js";
import auctionRoutes from "./routes/auctions.js";
import bidRoutes from "./routes/bids.js";
import notificationRoutes from "./routes/notifications.js";

// ======================
//  CONFIGURACIONES
// ======================
dotenv.config();
process.env.TZ = "America/Guatemala"; // ⏰ Fuerza zona horaria local

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ======================
//  SERVIDOR HTTP Y SOCKET.IO
// ======================
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ======================
//  MIDDLEWARE JWT para SOCKET.IO
// ======================
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Token no proporcionado"));
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return next(new Error("Token inválido o expirado"));
    socket.user = user;
    next();
  });
});

// ======================
//  EVENTOS DE SOCKET.IO
// ======================
io.on("connection", (socket) => {
  console.log(`⚡ Usuario conectado: ${socket.user.username}`);

  socket.on("disconnect", () => {
    console.log(`❌ Usuario desconectado: ${socket.user.username}`);
  });

  socket.on("newBid", async (data) => {
    try {
      const decoded = jwt.verify(data.token, process.env.JWT_SECRET);
      const userId = decoded.id;

      const [auctionRows] = await db.query(
        `SELECT end_time, base_price, status FROM auctions WHERE id_auctions = ?`,
        [data.id_auctions]
      );
      if (auctionRows.length === 0)
        return socket.emit("errorBid", { message: "Subasta no encontrada." });

      const auction = auctionRows[0];
      if (auction.status === "ended")
        return socket.emit("errorBid", { message: "La subasta ya finalizó." });

      const now = DateTime.now().setZone("America/Guatemala").toJSDate();
      const end = new Date(auction.end_time);
      if (now >= end)
        return socket.emit("errorBid", { message: "La subasta ha finalizado." });

      const [highest] = await db.query(
        `SELECT bid_amount FROM bids WHERE id_auctions = ? ORDER BY bid_amount DESC LIMIT 1`,
        [data.id_auctions]
      );
      const highestBid = highest.length ? highest[0].bid_amount : auction.base_price;
      if (data.bid_amount <= highestBid)
        return socket.emit("errorBid", { message: `La puja debe ser mayor a $${highestBid}.` });

      await db.query(
        `INSERT INTO bids (id_auctions, id_users, bid_amount, bid_time)
         VALUES (?, ?, ?, NOW())`,
        [data.id_auctions, userId, data.bid_amount]
      );

      const [userRows] = await db.query(`SELECT username FROM users WHERE id_users = ?`, [userId]);
      const username = userRows[0]?.username || "Usuario";

      io.emit("updateBids", {
        id_auctions: data.id_auctions,
        highestBid: data.bid_amount,
        highestBidUser: username,
      });

      console.log(`💰 Nueva puja de ${username}: $${data.bid_amount}`);
    } catch (err) {
      console.error("❌ Error en newBid:", err);
      socket.emit("errorBid", { message: "Error al procesar la puja." });
    }
  });
});

// ======================
//  RUTAS HTTP
// ======================
app.get("/api/time", (req, res) => res.json({ serverTime: new Date().toISOString() }));
app.use("/api/users", userRoutes);
app.use("/api/auctions", auctionRoutes(io));
app.use("/api/bids", bidRoutes);
app.use("/api/notifications", notificationRoutes);

// ======================
//  CRON (cada 5s): cierre de subastas y notificaciones
// ======================
cron.schedule("*/5 * * * * *", async () => {
  try {
    const [timeCheck] = await db.query("SELECT NOW(6) as server_time");
    const serverTime = new Date(timeCheck[0].server_time);

    const [endedAuctions] = await db.query(`
      SELECT a.id_auctions, a.id_users, a.title, a.end_time, u.username,
             TIMESTAMPDIFF(SECOND, a.end_time, NOW()) as seconds_past_end
      FROM auctions a
      INNER JOIN users u ON a.id_users = u.id_users
      WHERE a.status = 'active' AND a.end_time < NOW()
      ORDER BY a.end_time ASC
    `);

    for (const auction of endedAuctions) {
      console.log(`🏁 Procesando subasta #${auction.id_auctions}: ${auction.title}`);

      const [recentBidCheck] = await db.query(
        `SELECT MAX(bid_time) as last_bid_time FROM bids WHERE id_auctions = ?`,
        [auction.id_auctions]
      );

      const lastBidTime = recentBidCheck[0]?.last_bid_time ? new Date(recentBidCheck[0].last_bid_time) : null;
      if (lastBidTime && lastBidTime > new Date(auction.end_time)) {
        const diff = (serverTime - lastBidTime) / 1000;
        if (diff < 5) {
          console.log(`⏳ Esperando periodo de gracia (${5 - diff.toFixed(1)}s restantes)...`);
          continue;
        }
      }

      await db.query(`UPDATE auctions SET status = 'ended' WHERE id_auctions = ?`, [auction.id_auctions]);

      const [winnerData] = await db.query(
        `SELECT b.bid_amount, u.id_users, u.username
         FROM bids b INNER JOIN users u ON b.id_users = u.id_users
         WHERE b.id_auctions = ? ORDER BY b.bid_amount DESC, b.bid_time ASC LIMIT 1`,
        [auction.id_auctions]
      );

      if (winnerData.length) {
        const winner = winnerData[0];
        const formatted = parseFloat(winner.bid_amount).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });

        await db.query(
          `INSERT INTO notifications (id_user, id_auction, message, type, is_read, created_at)
           VALUES (?, ?, ?, 'success', 0, NOW())`,
          [winner.id_users, auction.id_auctions, `🏆 ¡Felicidades ${winner.username}! Ganaste "${auction.title}" con $${formatted}.`]
        );

        const [losers] = await db.query(
          `SELECT DISTINCT u.id_users FROM bids b INNER JOIN users u ON b.id_users = u.id_users WHERE b.id_auctions = ? AND u.id_users != ?`,
          [auction.id_auctions, winner.id_users]
        );

        for (const l of losers) {
          await db.query(
            `INSERT INTO notifications (id_user, id_auction, message, type, is_read, created_at)
             VALUES (?, ?, ?, 'info', 0, NOW())`,
            [l.id_users, auction.id_auctions, `😢 "${auction.title}" finalizó. Ganador: ${winner.username} con $${formatted}.`]
          );
        }

        io.emit("auctionEnded", {
          id_auctions: auction.id_auctions,
          title: auction.title,
          winner: winner.username,
          bid_amount: winner.bid_amount,
        });

        console.log(`✅ Subasta #${auction.id_auctions} cerrada correctamente.`);
      } else {
        await db.query(
          `INSERT INTO notifications (id_user, id_auction, message, type, is_read, created_at)
           VALUES (?, ?, ?, 'warning', 0, NOW())`,
          [auction.id_users, auction.id_auctions, `🕒 La subasta "${auction.title}" finalizó sin pujas.`]
        );

        io.emit("auctionEnded", {
          id_auctions: auction.id_auctions,
          title: auction.title,
          winner: null,
          bid_amount: null,
        });

        console.log(`🚫 Subasta #${auction.id_auctions} cerrada sin pujas.`);
      }
    }
  } catch (err) {
    console.error("❌ Error en cron de subastas:", err);
  }
});

// ======================
//  INICIO DEL SERVIDOR
// ======================
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});

export { io };
