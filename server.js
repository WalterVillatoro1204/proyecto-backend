// ======================
//  IMPORTACIONES PRINCIPALES
// ======================
import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import cron from "node-cron";
import { DateTime } from "luxon";
import { db } from "./db.js";

// ======================
//  RUTAS
// ======================
import userRoutes from "./routes/users.js";
import auctionRoutes from "./routes/auctions.js";
import bidRoutes from "./routes/bids.js";
import notificationRoutes from "./routes/notifications.js";

// ======================
//  CONFIGURACIONES
// ======================
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const server = http.createServer(app);

// ======================
//  SOCKET.IO
// ======================
const io = new Server(server, {
  cors: {
    origin: "*", // ⚠️ Ajusta a tu dominio del frontend si lo deseas
    methods: ["GET", "POST"],
  },
});

// ======================
//  VERIFICAR TOKEN JWT (para sockets)
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
//  EVENTOS DE SOCKET
// ======================
io.on("connection", (socket) => {
  console.log(`⚡ Usuario conectado: ${socket.user.username}`);

  socket.on("disconnect", () => {
    console.log(`❌ Usuario desconectado: ${socket.user.username}`);
  });

  // 📢 Cuando se recibe una nueva puja
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
      if (auction.status === "ended") {
        return socket.emit("errorBid", { message: "La subasta ya finalizó." });
      }

      const nowUTC = DateTime.utc().toJSDate();
      const endUTC = new Date(auction.end_time);
      if (nowUTC >= endUTC) {
        return socket.emit("errorBid", {
          message: "La subasta ha finalizado.",
        });
      }

      const [highest] = await db.query(
        `SELECT bid_amount FROM bids WHERE id_auctions = ? ORDER BY bid_amount DESC LIMIT 1`,
        [data.id_auctions]
      );

      const highestBid = highest.length > 0 ? highest[0].bid_amount : auction.base_price;
      if (data.bid_amount <= highestBid) {
        return socket.emit("errorBid", {
          message: `La puja debe ser mayor a $${highestBid}.`,
        });
      }

      // Insertar nueva puja
      await db.query(
        `INSERT INTO bids (id_auctions, id_users, bid_amount, bid_time)
         VALUES (?, ?, ?, UTC_TIMESTAMP())`,
        [data.id_auctions, userId, data.bid_amount]
      );

      // Obtener nombre del usuario
      const [userRows] = await db.query(
        `SELECT username FROM users WHERE id_users = ?`,
        [userId]
      );
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
app.use("/api/users", userRoutes);
app.use("/api/auctions", auctionRoutes(io));
app.use("/api/bids", bidRoutes);
app.use("/api/notifications", notificationRoutes);

// ======================
//  CRON: Cerrar subastas y notificar en tiempo real
// ======================
cron.schedule("* * * * *", async () => {
  try {
    console.log("⏱️ Ejecutando cron de verificación de subastas...");

    // 1️⃣ Hora actual en UTC
    const nowUTC = DateTime.utc().toSQL({ includeOffset: false });

    // 2️⃣ Buscar subastas activas ya vencidas
    const [endedAuctions] = await db.query(
      `
      SELECT a.id_auctions, a.id_users, a.title, u.username
      FROM auctions a
      INNER JOIN users u ON a.id_users = u.id_users
      WHERE a.status = 'active'
      AND a.end_time <= ?
      `,
      [nowUTC]
    );

    if (endedAuctions.length > 0) {
      console.log(`🏁 ${endedAuctions.length} subasta(s) finalizada(s).`);

      for (const auction of endedAuctions) {
        // 🔹 Marcar subasta como finalizada
        await db.query(`UPDATE auctions SET status = 'ended' WHERE id_auctions = ?`, [
          auction.id_auctions,
        ]);

        // 🔹 Obtener la puja más alta
        const [highestBid] = await db.query(
          `
          SELECT b.id_bids, b.bid_amount, u.username
          FROM bids b
          INNER JOIN users u ON b.id_users = u.id_users
          WHERE b.id_auctions = ?
          ORDER BY b.bid_amount DESC
          LIMIT 1
          `,
          [auction.id_auctions]
        );

        if (highestBid.length > 0) {
          const winner = highestBid[0];
          const messageWinner = `🏆 ¡Felicidades ${winner.username}! Ganaste la subasta "${auction.title}" con una puja de $${winner.bid_amount.toFixed(2)}.`;
          const messageLoser = `💔 La subasta "${auction.title}" finalizó. El ganador fue ${winner.username} con una puja de $${winner.bid_amount.toFixed(2)}. ¡Mejor suerte en la próxima!`;

          // 🥇 Notificar al ganador
          await db.query(
            `INSERT INTO notifications (id_users, id_auction, message, type)
             VALUES ((SELECT id_users FROM users WHERE username = ?), ?, ?, 'success')`,
            [winner.username, auction.id_auctions, messageWinner]
          );

          // 😞 Notificar a los demás
          const [otherUsers] = await db.query(
            `
            SELECT DISTINCT u.username
            FROM bids b
            INNER JOIN users u ON b.id_users = u.id_users
            WHERE b.id_auctions = ? AND u.username != ?
            `,
            [auction.id_auctions, winner.username]
          );

          for (const other of otherUsers) {
            await db.query(
              `INSERT INTO notifications (id_users, id_auction, message, type)
               VALUES ((SELECT id_users FROM users WHERE username = ?), ?, ?, 'info')`,
              [other.username, auction.id_auctions, messageLoser]
            );
          }

          // 🔔 Emitir evento de cierre en tiempo real
          io.emit("auctionEnded", {
            id_auctions: auction.id_auctions,
            title: auction.title,
            winner: winner.username,
            bid: winner.bid_amount,
          });

          console.log(`✅ Subasta ${auction.id_auctions} finalizada y notificada.`);
        } else {
          // ⚠️ Sin pujas
          const message = `🕒 La subasta "${auction.title}" finalizó sin pujas.`;
          await db.query(
            `INSERT INTO notifications (id_users, id_auction, message, type)
             VALUES (?, ?, ?, 'warning')`,
            [auction.id_users, auction.id_auctions, message]
          );

          io.emit("auctionEnded", {
            id_auctions: auction.id_auctions,
            title: auction.title,
            winner: null,
            bid: null,
          });
        }
      }
    } else {
      console.log("✅ No hay subastas finalizadas por ahora.");
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
