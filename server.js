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
// 🔄 Verificar subastas finalizadas
// ======================
async function checkEndedAuctions() {
  try {
    console.log("⏱️ Ejecutando verificación de subastas...");

    // 1️⃣ Obtener subastas que ya terminaron y siguen activas
    const [endedAuctions] = await db.query(`
      SELECT a.id_auctions, a.title, a.end_time
      FROM auctions a
      WHERE a.end_time <= NOW()
      AND a.status = 'active'
    `);

    const [rows] = await db.query("SELECT NOW() AS hora_mysql, UTC_TIMESTAMP() AS hora_utc");
    console.log("🕒 Hora MySQL local:", rows[0].hora_mysql);
    console.log("🕒 Hora UTC:", rows[0].hora_utc);

    if (endedAuctions.length === 0) {
      console.log("🟢 No hay subastas finalizadas por cerrar.");
      return;
    }

    console.log(`⚠️ Se encontraron ${endedAuctions.length} subasta(s) finalizada(s).`);

    for (const auction of endedAuctions) {
      const auctionId = auction.id_auctions;

      // 2️⃣ Obtener la puja más alta
      const [winner] = await db.query(
        `SELECT b.id_users, b.bid_amount, u.username
         FROM bids b
         JOIN users u ON b.id_users = u.id_users
         WHERE b.id_auctions = ?
         ORDER BY b.bid_amount DESC, b.bid_time ASC
         LIMIT 1`,
        [auctionId]
      );

      // 3️⃣ Actualizar estado de la subasta
      await db.query(`UPDATE auctions SET status = 'ended' WHERE id_auctions = ?`, [auctionId]);

      // 4️⃣ Registrar notificación según haya o no ganador
      if (winner.length > 0) {
        const userId = winner[0].id_users;
        const amount = winner[0].bid_amount;
        const username = winner[0].username;

        await db.query(
          `INSERT INTO notifications (id_auction, id_user, message)
           VALUES (?, ?, ?)`,
          [auctionId, userId, `🏆 🎉 ¡Felicidades ${username}! Ganaste la subasta #${auctionId} con una puja de $${amount.toLocaleString("en-US")}`]
        );

        console.log(`✅ Subasta #${auctionId} finalizada. Ganador: ${username} con $${amount}`);
      } else {
        await db.query(
          `INSERT INTO notifications (id_auction, id_user, message)
           VALUES (?, NULL, ?)`,
          [auctionId, `😢 Nadie ofertó en la subasta #${auctionId}.`]
        );
        console.log(`ℹ️ Subasta #${auctionId} finalizada sin pujas.`);
      }

      // 5️⃣ Emitir evento en tiempo real a todos los clientes conectados
      io.emit("auctionEnded", { id_auctions: auctionId });
    }
  } catch (err) {
    console.error("❌ Error en checkEndedAuctions:", err.message);
  }
}


// ======================
//  Configuración base
// ======================
app.use(express.json());
app.use(cors({
  origin: [
    "https://www.mycarbid.click",
    "https://mycarbid.click",
    "https://main.d3rcj7yl7zv9wm.amplifyapp.com",
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

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

      // 🔹 Obtener información de la subasta
      const [auctionData] = await db.query(
        `SELECT base_price, end_time, status FROM auctions WHERE id_auctions = ?`,
        [auctionId]
      );

      if (auctionData.length === 0) {
        socket.emit("errorBid", { message: "Subasta no encontrada." });
        return;
      }

      const basePrice = parseFloat(auctionData[0].base_price);
      const endTime = new Date(auctionData[0].end_time);
      const now = new Date();

      // 🚫 Si la subasta ya terminó
      if (now >= endTime || auctionData[0].status === "ended") {
        socket.emit("errorBid", { message: "La subasta ya ha finalizado." });
        return;
      }

      // 🔹 Obtener la puja más alta actual
      const [currentHighest] = await db.query(
        `SELECT bid_amount FROM bids WHERE id_auctions = ? ORDER BY bid_amount DESC LIMIT 1`,
        [auctionId]
      );

      const currentBid =
        currentHighest.length > 0
          ? parseFloat(currentHighest[0].bid_amount)
          : basePrice; // 🟢 Si no hay pujas, se usa el precio base como referencia mínima

      // 🚫 Validar monto: debe ser estrictamente mayor al actual o al base
      if (amount <= currentBid) {
        socket.emit("errorBid", {
          message: `Tu puja debe ser mayor a $${currentBid.toFixed(2)}`,
        });
        return;
      }

      // ✅ Registrar la puja
      await db.query(
        "INSERT INTO bids (id_auctions, id_users, bid_amount) VALUES (?, ?, ?)",
        [auctionId, userId, amount]
      );

      console.log(`✅ Puja registrada: usuario ${decoded.username}, subasta ${auctionId}, $${amount}`);

      // 🔹 Obtener la nueva puja más alta
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
  cron.schedule("*/10 * * * * *", checkEndedAuctions);
});

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
  cron.schedule("*/10 * * * * *", checkEndedAuctions);
});