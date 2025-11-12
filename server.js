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
//  CRON: Cerrar subastas y notificar en tiempo real (CADA 5 SEGUNDOS)
// ======================
cron.schedule("*/5 * * * * *", async () => {
  try {
    // 1️⃣ Obtener hora exacta del servidor MySQL
    const [timeCheck] = await db.query("SELECT NOW(6) as server_time");
    const serverTime = new Date(timeCheck[0].server_time);
    
    // 2️⃣ Buscar subastas activas que ya deberían estar cerradas
    const [endedAuctions] = await db.query(
      `
      SELECT 
        a.id_auctions, 
        a.id_users, 
        a.title, 
        a.end_time,
        u.username,
        TIMESTAMPDIFF(SECOND, a.end_time, NOW()) as seconds_past_end
      FROM auctions a
      INNER JOIN users u ON a.id_users = u.id_users
      WHERE a.status = 'active'
        AND a.end_time < NOW()
        AND TIMESTAMPDIFF(SECOND, a.end_time, NOW()) >= 1
      ORDER BY a.end_time ASC
      `
    );

    if (endedAuctions.length > 0) {
      console.log(`\n🏁 ${endedAuctions.length} subasta(s) por finalizar...`);

      for (const auction of endedAuctions) {
        console.log(`\n📋 Procesando subasta #${auction.id_auctions} (${auction.title})`);
        console.log(`   ⏰ Fin programado: ${new Date(auction.end_time).toISOString()}`);
        console.log(`   ⏱️  Segundos desde fin: ${auction.seconds_past_end}`);

        // 🔹 Verificar si hay pujas muy recientes (últimos 3 segundos)
        const [recentBidCheck] = await db.query(
          `
          SELECT 
            MAX(bid_time) as last_bid_time,
            TIMESTAMPDIFF(SECOND, MAX(bid_time), NOW()) as seconds_since_last_bid
          FROM bids
          WHERE id_auctions = ?
          `,
          [auction.id_auctions]
        );

        if (recentBidCheck[0]?.last_bid_time) {
          const secondsSinceLastBid = recentBidCheck[0].seconds_since_last_bid;
          const lastBidTime = new Date(recentBidCheck[0].last_bid_time);
          
          console.log(`   🔔 Última puja: ${lastBidTime.toISOString()}`);
          console.log(`   ⏱️  Segundos desde última puja: ${secondsSinceLastBid}`);

          // Si la última puja fue DESPUÉS del fin, dar gracia de 5 segundos
          if (lastBidTime > new Date(auction.end_time)) {
            console.log(`   ⚠️  PUJA TARDÍA detectada. Aplicando gracia...`);
            if (secondsSinceLastBid < 5) {
              console.log(`   ⏳ Esperando gracia (${5 - secondsSinceLastBid}s restantes)\n`);
              continue;
            }
          }
        }

        // 🔒 CERRAR LA SUBASTA
        console.log(`   🔒 CERRANDO subasta #${auction.id_auctions}...`);

        await db.query(
          `UPDATE auctions SET status = 'ended' WHERE id_auctions = ?`,
          [auction.id_auctions]
        );

        console.log(`   ✅ Estado actualizado a 'ended'`);

        // 🔹 Obtener la puja ganadora
        const [highestBid] = await db.query(
          `
          SELECT b.id_bids, b.bid_amount, b.bid_time, u.id_users, u.username
          FROM bids b
          INNER JOIN users u ON b.id_users = u.id_users
          WHERE b.id_auctions = ?
          ORDER BY b.bid_amount DESC, b.bid_time ASC
          LIMIT 1
          `,
          [auction.id_auctions]
        );

        if (highestBid.length > 0) {
          const winner = highestBid[0];
          const formattedAmount = parseFloat(winner.bid_amount).toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });

          console.log(`   🏆 GANADOR: ${winner.username} con $${formattedAmount}`);

          const messageWinner = `🏆 ¡Felicidades ${winner.username}! Ganaste la subasta "${auction.title}" con una puja de $${formattedAmount}.`;
          const messageLoser = `😢 La subasta "${auction.title}" finalizó. El ganador fue ${winner.username} con una puja de $${formattedAmount}. ¡Mejor suerte en la próxima!`;

          // 🥇 Notificar al ganador
          await db.query(
            `INSERT INTO notifications (id_user, id_auction, message, type, is_read, created_at)
             VALUES (?, ?, ?, 'success', 0, NOW())`,
            [winner.id_users, auction.id_auctions, messageWinner]
          );

          // 😞 Obtener y notificar a los perdedores
          const [otherUsers] = await db.query(
            `
            SELECT DISTINCT u.id_users, u.username
            FROM bids b
            INNER JOIN users u ON b.id_users = u.id_users
            WHERE b.id_auctions = ? AND u.id_users != ?
            `,
            [auction.id_auctions, winner.id_users]
          );

          for (const other of otherUsers) {
            await db.query(
              `INSERT INTO notifications (id_user, id_auction, message, type, is_read, created_at)
               VALUES (?, ?, ?, 'info', 0, NOW())`,
              [other.id_users, auction.id_auctions, messageLoser]
            );
          }

          console.log(`   📨 Notificaciones enviadas: 1 ganador + ${otherUsers.length} perdedores`);

          // 🔔 Emitir evento WebSocket de cierre
          io.emit("auctionEnded", {
            id_auctions: auction.id_auctions,
            title: auction.title,
            winner: winner.username,
            bid_amount: winner.bid_amount,
          });

          console.log(`   ✅ Subasta #${auction.id_auctions} procesada completamente\n`);

        } else {
          // ⚠️ Sin pujas
          console.log(`   🚫 Subasta cerrada SIN PUJAS`);

          const message = `🕒 La subasta "${auction.title}" finalizó sin pujas.`;
          
          await db.query(
            `INSERT INTO notifications (id_user, id_auction, message, type, is_read, created_at)
             VALUES (?, ?, ?, 'warning', 0, NOW())`,
            [auction.id_users, auction.id_auctions, message]
          );

          io.emit("auctionEnded", {
            id_auctions: auction.id_auctions,
            title: auction.title,
            winner: null,
            bid_amount: null,
          });

          console.log(`   ✅ Subasta #${auction.id_auctions} sin pujas procesada\n`);
        }
      }
    }
    // No mostrar mensaje si no hay subastas (para evitar spam en logs)
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
