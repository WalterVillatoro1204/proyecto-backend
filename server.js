// ==============================================
//  SERVER.JS - ADAPTADO PARA MYSQL SIN UTC GLOBAL
// ==============================================

import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import cron from "node-cron";
import { db } from "./db.js";

import userRoutes from "./routes/users.js";
import auctionRoutes from "./routes/auctions.js";
import bidRoutes from "./routes/bids.js";
import notificationRoutes from "./routes/notifications.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Token no proporcionado"));

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return next(new Error("Token inválido o expirado"));
    socket.user = user;
    next();
  });
});

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
      if (auction.status === "ended") {
        return socket.emit("errorBid", { message: "La subasta ya finalizó." });
      }

      // ✅ CRÍTICO: Usar UTC_TIMESTAMP() en lugar de NOW()
      const [timeCheck] = await db.query(
        "SELECT UTC_TIMESTAMP() as now, ? as end_time", 
        [auction.end_time]
      );
      const now = new Date(timeCheck[0].now);
      const endTime = new Date(timeCheck[0].end_time);

      if (now >= endTime) {
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

      // ✅ Usar UTC_TIMESTAMP() para bid_time
      await db.query(
        `INSERT INTO bids (id_auctions, id_users, bid_amount, bid_time)
         VALUES (?, ?, ?, UTC_TIMESTAMP())`,
        [data.id_auctions, userId, data.bid_amount]
      );

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
app.get("/api/time", (req, res) => {
  res.json({ 
    serverTime: Date.now(),
    serverTimeISO: new Date().toISOString()
  });
});

app.get("/api/health", async (req, res) => {
  try {
    const [result] = await db.query("SELECT 1");
    const [timeCheck] = await db.query(
      "SELECT NOW() as now, UTC_TIMESTAMP() as utc"
    );
    
    res.json({
      status: "OK",
      serverTime: new Date().toISOString(),
      mysqlNow: timeCheck[0].now,
      mysqlUTC: timeCheck[0].utc,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    });
  } catch (err) {
    res.status(500).json({ status: "ERROR", error: err.message });
  }
});

app.use("/api/users", userRoutes);
app.use("/api/auctions", auctionRoutes);
app.use("/api/bids", bidRoutes);
app.use("/api/notifications", notificationRoutes);

// ======================
//  ⚡ CRON OPTIMIZADO - USA UTC_TIMESTAMP()
// ======================
cron.schedule("* * * * * *", async () => {
  try {
    // ✅ CRÍTICO: Usar UTC_TIMESTAMP() en lugar de NOW()
    const [endedAuctions] = await db.query(
      `SELECT a.id_auctions, a.id_users, a.title, a.end_time
       FROM auctions a
       WHERE a.status = 'active' 
         AND a.end_time <= UTC_TIMESTAMP()
       ORDER BY a.end_time ASC
       LIMIT 10`
    );

    if (endedAuctions.length === 0) return;

    console.log(`\n🏁 Procesando ${endedAuctions.length} subasta(s) finalizada(s)...`);

    for (const auction of endedAuctions) {
      console.log(`\n📋 Cerrando subasta #${auction.id_auctions}: "${auction.title}"`);

      await db.query(
        `UPDATE auctions SET status = 'ended' WHERE id_auctions = ? AND status = 'active'`,
        [auction.id_auctions]
      );

      const [highestBid] = await db.query(
        `SELECT b.id_bids, b.bid_amount, b.bid_time, u.id_users, u.username
         FROM bids b
         INNER JOIN users u ON b.id_users = u.id_users
         WHERE b.id_auctions = ?
         ORDER BY b.bid_amount DESC, b.bid_time ASC
         LIMIT 1`,
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

        // ✅ Usar UTC_TIMESTAMP() para created_at
        await db.query(
          `INSERT INTO notifications (id_user, id_auction, message, type, is_read, created_at)
           VALUES (?, ?, ?, 'success', 0, UTC_TIMESTAMP())`,
          [winner.id_users, auction.id_auctions, messageWinner]
        );

        const [otherUsers] = await db.query(
          `SELECT DISTINCT u.id_users, u.username
           FROM bids b
           INNER JOIN users u ON b.id_users = u.id_users
           WHERE b.id_auctions = ? AND u.id_users != ?`,
          [auction.id_auctions, winner.id_users]
        );

        for (const other of otherUsers) {
          await db.query(
            `INSERT INTO notifications (id_user, id_auction, message, type, is_read, created_at)
             VALUES (?, ?, ?, 'info', 0, UTC_TIMESTAMP())`,
            [other.id_users, auction.id_auctions, messageLoser]
          );
        }

        console.log(`   📨 Notificaciones: 1 ganador + ${otherUsers.length} perdedores`);

        io.emit("auctionEnded", {
          id_auctions: auction.id_auctions,
          title: auction.title,
          winner: winner.username,
          bid_amount: winner.bid_amount,
        });

        console.log(`   ✅ Subasta #${auction.id_auctions} finalizada correctamente\n`);

      } else {
        console.log(`   🚫 Sin pujas registradas`);

        const message = `🕒 La subasta "${auction.title}" finalizó sin pujas.`;
        
        await db.query(
          `INSERT INTO notifications (id_user, id_auction, message, type, is_read, created_at)
           VALUES (?, ?, ?, 'warning', 0, UTC_TIMESTAMP())`,
          [auction.id_users, auction.id_auctions, message]
        );

        io.emit("auctionEnded", {
          id_auctions: auction.id_auctions,
          title: auction.title,
          winner: null,
          bid_amount: null,
        });

        console.log(`   ✅ Subasta #${auction.id_auctions} cerrada sin pujas\n`);
      }
    }
  } catch (err) {
    console.error("❌ Error en cron de subastas:", err);
  }
});

const PORT = process.env.PORT || 8081;
server.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
  console.log(`📡 WebSocket habilitado`);
  console.log(`⏰ CRON ejecutándose cada 1 segundo`);
  console.log(`⚙️  Usando UTC_TIMESTAMP() para todas las comparaciones`);
});

export { io };