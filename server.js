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
    
    // ✅ Verificar que se aplicó correctamente
    const [result] = await db.query("SELECT NOW() as hora_actual, @@session.time_zone as zona");
    console.log("🕓 Zona horaria MySQL configurada:");
    console.log("   📍 Zona:", result[0].zona);
    console.log("   ⏰ Hora actual:", result[0].hora_actual);
    
  } catch (err) {
    console.warn("⚠️ No se pudo fijar zona horaria:", err.message);
  }
}

/* ======================================================
🔄 FUNCIÓN: Verificar subastas finalizadas (VERSIÓN FINAL)
====================================================== */
async function checkEndedAuctions() {
  try {
    // ✅ Obtener hora actual del servidor MySQL con precisión
    const [timeCheck] = await db.query("SELECT NOW(6) as server_time");
    const serverTime = new Date(timeCheck[0].server_time);
    
    console.log(`⏰ [${serverTime.toISOString()}] Verificando subastas...`);

    // ✅ Buscar subastas que ya deberían estar cerradas
    const [rows] = await db.query(`
      SELECT 
        id_auctions, 
        title, 
        end_time,
        TIMESTAMPDIFF(SECOND, end_time, NOW()) as seconds_past_end
      FROM auctions
      WHERE status = 'active'
        AND end_time < NOW()
      ORDER BY end_time ASC
    `);

    if (!rows.length) {
      return; // No hay subastas para cerrar
    }

    for (const auction of rows) {
      const { id_auctions, title, end_time, seconds_past_end } = auction;
      
      console.log(`\n📋 Evaluando subasta #${id_auctions} (${title})`);
      console.log(`   ⏰ Fin programado: ${new Date(end_time).toISOString()}`);
      console.log(`   ⏱️  Tiempo transcurrido desde fin: ${seconds_past_end} segundos`);

      // ❌ SI NO HA PASADO AL MENOS 1 SEGUNDO desde el fin, SALTAR
      if (seconds_past_end < 1) {
        console.log(`   ⏳ Aún no cumple el segundo completo. Esperando...`);
        continue;
      }

      // ✅ Verificar última puja registrada
      const [lastBidInfo] = await db.query(`
        SELECT 
          MAX(bid_time) as last_bid_time,
          TIMESTAMPDIFF(SECOND, MAX(bid_time), NOW()) as seconds_since_last_bid
        FROM bids
        WHERE id_auctions = ?
      `, [id_auctions]);

      if (lastBidInfo[0]?.last_bid_time) {
        const secondsSinceLastBid = lastBidInfo[0].seconds_since_last_bid;
        const lastBidTime = new Date(lastBidInfo[0].last_bid_time);
        
        console.log(`   🔔 Última puja: ${lastBidTime.toISOString()}`);
        console.log(`   ⏱️  Segundos desde última puja: ${secondsSinceLastBid}`);

        // ❌ Si la última puja fue DESPUÉS del tiempo de fin, NO cerrar aún
        if (lastBidTime > new Date(end_time)) {
          console.log(`   ⚠️  PUJA TARDÍA detectada después del fin. Aplicando gracia de 5 segundos...`);
          
          // Solo cerrar si han pasado al menos 5 segundos desde esa puja tardía
          if (secondsSinceLastBid < 5) {
            console.log(`   ⏳ Esperando gracia para puja tardía (${5 - secondsSinceLastBid}s restantes)`);
            continue;
          }
        }
      }

      // 🎯 LLEGÓ EL MOMENTO: Cerrar la subasta
      console.log(`   🔒 CERRANDO subasta #${id_auctions}...`);

      // ✅ Buscar ganador
      const [winner] = await db.query(`
        SELECT b.id_users, b.bid_amount, b.bid_time, u.username
        FROM bids b
        JOIN users u ON u.id_users = b.id_users
        WHERE b.id_auctions = ?
        ORDER BY b.bid_amount DESC, b.bid_time ASC
        LIMIT 1
      `, [id_auctions]);

      // ✅ Actualizar estado a 'ended'
      await db.query(
        "UPDATE auctions SET status = 'ended' WHERE id_auctions = ?", 
        [id_auctions]
      );
      
      console.log(`   ✅ Estado actualizado a 'ended' en BD`);

      // ✅ Emitir evento de cierre por WebSocket
      io.emit("auctionEnded", { 
        id_auctions, 
        winner: winner.length > 0 ? winner[0].username : null,
        bid_amount: winner.length > 0 ? winner[0].bid_amount : null
      });

      if (winner.length > 0) {
        const { id_users, bid_amount, username, bid_time } = winner[0];
        const formattedAmount = parseFloat(bid_amount).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });

        console.log(`   🏆 GANADOR: ${username} con $${formattedAmount}`);
        console.log(`   🕐 Puja ganadora realizada: ${new Date(bid_time).toISOString()}`);

        // 📧 Notificación al ganador
        const winnerMessage = `🏆 🎉 ¡Felicidades ${username}! Ganaste la subasta #${id_auctions} (${title}) con una puja de $${formattedAmount}.`;
        
        await db.query(`
          INSERT INTO notifications (id_auction, id_user, message, created_at)
          SELECT ?, ?, ?, NOW()
          WHERE NOT EXISTS (
            SELECT 1 FROM notifications
            WHERE id_auction = ? AND id_user = ? AND message LIKE '🏆 %'
          )
        `, [id_auctions, id_users, winnerMessage, id_auctions, id_users]);

        // 📧 Notificaciones a perdedores
        const [allBidders] = await db.query(`
          SELECT DISTINCT b.id_users, u.username, MAX(b.bid_amount) as max_bid
          FROM bids b
          JOIN users u ON u.id_users = b.id_users
          WHERE b.id_auctions = ? AND b.id_users != ?
          GROUP BY b.id_users, u.username
        `, [id_auctions, id_users]);

        for (const bidder of allBidders) {
          const loserMessage = `😢 La subasta #${id_auctions} (${title}) finalizó. ${username} ganó con $${formattedAmount}. ¡Mejor suerte en la próxima!`;
          
          await db.query(`
            INSERT INTO notifications (id_auction, id_user, message, created_at)
            SELECT ?, ?, ?, NOW()
            WHERE NOT EXISTS (
              SELECT 1 FROM notifications
              WHERE id_auction = ? AND id_user = ? AND message LIKE '😢 %'
            )
          `, [id_auctions, bidder.id_users, loserMessage, id_auctions, bidder.id_users]);
        }

        console.log(`   📨 Notificaciones enviadas: 1 ganador + ${allBidders.length} perdedores`);

      } else {
        // ❌ Sin pujas
        console.log(`   🚫 Subasta cerrada SIN PUJAS`);
        
        const noWinnerMessage = `😢 Nadie ofertó en la subasta #${id_auctions} (${title}).`;
        await db.query(`
          INSERT INTO notifications (id_auction, id_user, message, created_at)
          SELECT ?, NULL, ?, NOW()
          WHERE NOT EXISTS (
            SELECT 1 FROM notifications
            WHERE id_auction = ? AND message LIKE '😢 Nadie%'
          )
        `, [id_auctions, noWinnerMessage, id_auctions]);
      }

      console.log(`   ✅ Subasta #${id_auctions} procesada completamente\n`);
    }

  } catch (err) {
    console.error("❌ Error en checkEndedAuctions:", err.message);
    console.error(err.stack);
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

  const [time] = await db.query("SELECT NOW(6) AS hora_servidor");
  console.log("🕒 Hora MySQL con microsegundos:", time[0].hora_servidor);

  try {
    const [rows] = await db.query("SELECT NOW() AS hora_servidor");
    console.log("🕒 Hora actual en MySQL:", rows[0].hora_servidor);
  } catch (err) {
    console.error("❌ Error al conectar con la DB:", err.message);
  }

  console.log("⏰ Iniciando cron job...");
  cron.schedule("*/2 * * * * *", checkEndedAuctions);
});
