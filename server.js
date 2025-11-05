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

// ======================
//  Configuración base
// ======================
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true,
}));

app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ======================
//  Rutas API
// ======================
app.use("/api/users", userRoutes);
app.use("/api/auctions", auctionRoutes(io)); 
app.use("/api/bids", bidRoutes);
app.use("/api/notifications", notificationRoutes);

// ======================
//  Health check (SIN dependencia de DB)
// ======================
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// ======================
//  Endpoint root (CON verificación de DB)
// ======================
app.get("/", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT NOW() AS time");
    return res.status(200).json({ ok: true, db_time: rows[0].time });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ======================
//  Middleware de autenticación de Socket.IO
// ======================
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

// ======================
//  Conexión de WebSocket
// ======================
io.on("connection", (socket) => {
  console.log("🟢 Cliente conectado:", socket.id, "| Usuario:", socket.username);

  socket.on("newBid", async (bidData) => {
    console.log("📩 NUEVA PUJA RECIBIDA:", bidData);
    try {
      const { token, id_auctions, bid_amount } = bidData;

      if (!token) {
        socket.emit("errorBid", { message: "Token requerido" });
        return;
      }

      let decoded;
      try {
        decoded = jwt.verify(token, secret);
      } catch {
        socket.emit("errorBid", { message: "Token inválido o expirado" });
        return;
      }

      const userId = decoded.id;
      const auctionId = parseInt(id_auctions);
      const amount = parseFloat(bid_amount);

      if (!auctionId || isNaN(amount) || amount <= 0) {
        socket.emit("errorBid", { message: "Datos de puja inválidos." });
        return;
      }

      console.log(`💬 Puja recibida: usuario ${decoded.username}, subasta ${auctionId}, monto $${amount}`);

      const [currentHighest] = await db.query(
        `SELECT bid_amount FROM bids WHERE id_auctions = ? ORDER BY bid_amount DESC LIMIT 1`,
        [auctionId]
      );

      if (currentHighest.length > 0 && amount <= currentHighest[0].bid_amount) {
        socket.emit("errorBid", {
          message: `Tu puja debe ser mayor a $${currentHighest[0].bid_amount}`,
        });
        return;
      }

      await db.query(
        "INSERT INTO bids (id_auctions, id_users, bid_amount) VALUES (?, ?, ?)",
        [auctionId, userId, amount]
      );

      console.log(`✅ Puja registrada correctamente en la subasta #${auctionId}`);

      const [highest] = await db.query(
        `SELECT b.bid_amount, u.username 
         FROM bids b
         JOIN users u ON b.id_users = u.id_users
         WHERE b.id_auctions = ?
         ORDER BY b.bid_amount DESC, b.bid_time ASC
         LIMIT 1`,
        [auctionId]
      );

      const newHighest = {
        id_auctions: auctionId,
        highestBid: highest[0]?.bid_amount || amount,
        highestBidUser: highest[0]?.username || decoded.username,
      };

      io.emit("updateBids", newHighest);
    } catch (error) {
      console.error("❌ Error al registrar la puja:", error);
      socket.emit("errorBid", { message: "Error interno al registrar la puja" });
    }
  });

  socket.on("disconnect", () => {
    console.log("🔴 Cliente desconectado:", socket.id);
  });
});

// ======================
//  Función del Cron Job
// ======================
async function checkEndedAuctions() {
  try {
    console.log("⏱️ Ejecutando cron de verificación de subastas...");

    const [endedAuctions] = await db.query(`
      SELECT a.id_auctions
      FROM auctions a
      WHERE a.end_time <= NOW()
      AND a.id_auctions NOT IN (
        SELECT n.id_auction FROM notifications n
      )
    `);

    if (endedAuctions.length === 0) {
      console.log("ℹ️ No hay subastas finalizadas pendientes de notificación.");
      return;
    }

    for (const auction of endedAuctions) {
      console.log(`⚙️ Procesando subasta #${auction.id_auctions}...`);

      const [winner] = await db.query(`
        SELECT b.id_users, u.username, b.bid_amount
        FROM bids b
        JOIN users u ON b.id_users = u.id_users
        WHERE b.id_auctions = ?
        ORDER BY b.bid_amount DESC, b.bid_time ASC
        LIMIT 1
      `, [auction.id_auctions]);

      if (winner.length === 0) {
        console.log(`⚠️ Subasta #${auction.id_auctions} no tiene pujas.`);
        continue;
      }

      const userIdWinner = winner[0].id_users;
      const usernameWinner = winner[0].username;
      const bidAmountWinner = winner[0].bid_amount;

      const messageWinner = `🎉 ¡Felicidades ${usernameWinner}! Ganaste la subasta #${auction.id_auctions} con una puja de $${bidAmountWinner}.`;

      await db.query(
        "INSERT INTO notifications (id_user, id_auction, message) VALUES (?, ?, ?)",
        [userIdWinner, auction.id_auctions, messageWinner]
      );

      io.to(`user_${userIdWinner}`).emit("newNotification", {
        message: messageWinner,
        auctionId: auction.id_auctions,
      });

      console.log(`✅ Notificación enviada al ganador: ${usernameWinner}`);

      const [losers] = await db.query(`
        SELECT DISTINCT b.id_users, u.username
        FROM bids b
        JOIN users u ON b.id_users = u.id_users
        WHERE b.id_auctions = ? AND b.id_users != ?
      `, [auction.id_auctions, userIdWinner]);

      if (losers.length === 0) {
        console.log(`ℹ️ No hay perdedores en la subasta #${auction.id_auctions}`);
        continue;
      }

      for (const loser of losers) {
        const messageLoser = `😢 Hola ${loser.username}, la subasta #${auction.id_auctions} finalizó. El ganador fue ${usernameWinner} con una puja de $${bidAmountWinner}. ¡Mejor suerte en la próxima!`;

        await db.query(
          "INSERT INTO notifications (id_user, id_auction, message) VALUES (?, ?, ?)",
          [loser.id_users, auction.id_auctions, messageLoser]
        );

        io.to(`user_${loser.id_users}`).emit("newNotification", {
          message: messageLoser,
          auctionId: auction.id_auctions,
        });

        console.log(`📩 Notificación enviada al perdedor: ${loser.username}`);
      }
    }
  } catch (err) {
    console.error("❌ Error en cron de verificación:", err.message);
  }
}

// ======================
//  Iniciar servidor
// ======================
server.listen(PORT, async () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  
  try {
    const [rows] = await db.query("SELECT NOW() AS hora_servidor");
    console.log("🕒 Hora actual en MySQL:", rows[0].hora_servidor);
  } catch (err) {
    console.error("❌ Error al conectar con la DB:", err.message);
  }

  // Iniciar cron job DESPUÉS de que el servidor esté corriendo
  console.log("⏰ Iniciando cron job...");
  cron.schedule("* * * * *", checkEndedAuctions);
});