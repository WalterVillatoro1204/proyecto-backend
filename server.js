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
    const [result] = await db.query(
      "SELECT NOW() as hora_actual, @@session.time_zone as zona"
    );
    console.log("🕓 Zona horaria MySQL configurada:");
    console.log("   📍 Zona:", result[0].zona);
    console.log("   ⏰ Hora actual:", result[0].hora_actual);
  } catch (err) {
    console.warn("⚠️ No se pudo fijar zona horaria:", err.message);
  }
}

async function checkEndedAuctions() {
  try {
    // 🕒 Obtener hora del servidor MySQL (en UTC)
    const [timeCheck] = await db.query("SELECT NOW(6) as server_time");
    const mysqlTime = new Date(timeCheck[0].server_time);

    // 🔧 Ajustar manualmente la hora MySQL a Guatemala (UTC-6)
    const serverTime = new Date(mysqlTime.getTime() - 6 * 60 * 60 * 1000);

    console.log(`⏰ [${serverTime.toISOString()}] Verificando subastas (hora local ajustada)`);

    // 🔍 Buscar subastas activas que ya pasaron su fin según la hora local
    const [rows] = await db.query(`
      SELECT id_auctions, title, end_time
      FROM auctions
      WHERE status = 'active'
      ORDER BY end_time ASC
    `);

    if (!rows.length) return;

    for (const auction of rows) {
      const { id_auctions, title, end_time } = auction;

      const endTime = new Date(end_time);
      const now = new Date(serverTime); // usar hora ajustada
      const diffSeconds = (now - endTime) / 1000;

      console.log(`\n📋 Subasta #${id_auctions} (${title})`);
      console.log(`   🕒 Fin programado: ${endTime.toISOString()}`);
      console.log(`   🕓 Hora actual: ${now.toISOString()}`);
      console.log(`   ⏱️ Diferencia: ${diffSeconds.toFixed(2)} segundos`);

      // ⏳ Si aún no ha terminado, saltar
      if (now < endTime) {
        console.log("   🚫 Aún no finaliza (esperando su tiempo real)");
        continue;
      }

      // ⚖️ Esperar 2 s tras el fin antes de cerrar
      if (diffSeconds < 2) {
        console.log("   ⏳ Esperando margen de 2 s tras el fin...");
        continue;
      }

      // 🕵️‍♂️ Revisar si hubo una puja en los últimos 3 s
      const [recentBid] = await db.query(`
        SELECT MAX(bid_time) AS last_bid_time
        FROM bids
        WHERE id_auctions = ?;
      `, [id_auctions]);

      if (recentBid[0]?.last_bid_time) {
        const lastBidTime = new Date(recentBid[0].last_bid_time);
        const diffFromLastBid = (now - lastBidTime) / 1000;
        if (lastBidTime > endTime && diffFromLastBid < 3) {
          console.log(`   ⏳ Puja reciente (${diffFromLastBid.toFixed(2)} s). Esperando siguiente ciclo.`);
          continue;
        }
      }

      // 🔒 Cerrar la subasta
      console.log(`   🔒 Cerrando subasta #${id_auctions}...`);
      await db.query("UPDATE auctions SET status = 'ended' WHERE id_auctions = ?", [id_auctions]);

      // 🏆 Buscar ganador
      const [winner] = await db.query(`
        SELECT b.id_users, b.bid_amount, u.username
        FROM bids b
        JOIN users u ON u.id_users = b.id_users
        WHERE b.id_auctions = ?
        ORDER BY b.bid_amount DESC, b.bid_time ASC
        LIMIT 1
      `, [id_auctions]);

      // Emitir evento por WebSocket
      io.emit("auctionEnded", {
        id_auctions,
        winner: winner.length ? winner[0].username : null,
        bid_amount: winner.length ? winner[0].bid_amount : null,
      });

      if (winner.length) {
        const { id_users, bid_amount, username } = winner[0];
        const formattedAmount = parseFloat(bid_amount).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });

        console.log(`   🏆 Ganador: ${username} con $${formattedAmount}`);

        // 📨 Notificar ganador
        const winnerMsg = `🏆 🎉 ¡Felicidades ${username}! Ganaste la subasta #${id_auctions} (${title}) con una puja de $${formattedAmount}.`;
        await db.query(`
          INSERT INTO notifications (id_auction, id_user, message, created_at)
          SELECT ?, ?, ?, NOW()
          WHERE NOT EXISTS (
            SELECT 1 FROM notifications
            WHERE id_auction = ? AND id_user = ? AND message LIKE '🏆 %'
          )
        `, [id_auctions, id_users, winnerMsg, id_auctions, id_users]);

        // 📨 Notificar perdedores
        const [others] = await db.query(`
          SELECT DISTINCT b.id_users, u.username
          FROM bids b
          JOIN users u ON u.id_users = b.id_users
          WHERE b.id_auctions = ? AND b.id_users != ?
        `, [id_auctions, id_users]);

        for (const o of others) {
          const msg = `😢 La subasta #${id_auctions} (${title}) finalizó. ${username} ganó con $${formattedAmount}. ¡Mejor suerte en la próxima!`;
          await db.query(`
            INSERT INTO notifications (id_auction, id_user, message, created_at)
            SELECT ?, ?, ?, NOW()
            WHERE NOT EXISTS (
              SELECT 1 FROM notifications
              WHERE id_auction = ? AND id_user = ? AND message LIKE '😢 %'
            )
          `, [id_auctions, o.id_users, msg, id_auctions, o.id_users]);
        }

        console.log(`   📨 Notificaciones: 1 ganador + ${others.length} perdedores`);
      } else {
        // 🚫 Sin pujas
        console.log(`   🚫 Subasta #${id_auctions} sin pujas.`);
        const msg = `😢 Nadie ofertó en la subasta #${id_auctions} (${title}).`;
        await db.query(`
          INSERT INTO notifications (id_auction, id_user, message, created_at)
          SELECT ?, NULL, ?, NOW()
          WHERE NOT EXISTS (
            SELECT 1 FROM notifications
            WHERE id_auction = ? AND message LIKE '😢 Nadie%'
          )
        `, [id_auctions, msg, id_auctions]);
      }

      console.log(`   ✅ Subasta #${id_auctions} procesada correctamente.\n`);
    }
  } catch (err) {
    console.error("❌ Error en checkEndedAuctions:", err.message);
    console.error(err.stack);
  }
}

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
  cors: { origin: "*", methods: ["GET", "POST"] }
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
app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

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

      const [auctionRows] = await db.query(
        "SELECT CAST(base_price AS DECIMAL(10,2)) AS base_price, end_time, status FROM auctions WHERE id_auctions = ?",
        [auctionId]
      );

      if (!auctionRows.length)
        return socket.emit("errorBid", { message: "Subasta no encontrada." });

      const basePrice = parseFloat(auctionRows[0].base_price || "0");
      const endTime = new Date(auctionRows[0].end_time);
      const now = new Date();

      if (auctionRows[0].status === "ended" || now >= endTime)
        return socket.emit("errorBid", { message: "La subasta ya ha finalizado." });

      const [maxRows] = await db.query(
        "SELECT bid_amount FROM bids WHERE id_auctions = ? ORDER BY bid_amount DESC LIMIT 1",
        [auctionId]
      );

      const highestBid = maxRows.length ? parseFloat(maxRows[0].bid_amount || 0) : 0;
      const threshold = Math.max(basePrice, highestBid);

      if (amount <= threshold) {
        return socket.emit("errorBid", {
          message: `La puja mínima debe ser mayor a $${threshold.toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
          })}.`,
        });
      }

      await db.query(
        "INSERT INTO bids (id_auctions, id_users, bid_amount) VALUES (?, ?, ?)",
        [auctionId, userId, amount]
      );

      console.log(`✅ Puja registrada: ${decoded.username} -> #${auctionId} $${amount}`);

      const [highest] = await db.query(`
        SELECT b.bid_amount, u.username
        FROM bids b
        JOIN users u ON u.id_users = b.id_users
        WHERE b.id_auctions = ?
        ORDER BY b.bid_amount DESC, b.bid_time ASC
        LIMIT 1
      `, [auctionId]);

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
  await setTimezone();

  const [time] = await db.query("SELECT NOW(6) AS hora_servidor");
  console.log("🕒 Hora MySQL con microsegundos:", time[0].hora_servidor);

  try {
    const [rows] = await db.query("SELECT NOW() AS hora_servidor");
    console.log("🕒 Hora actual en MySQL:", rows[0].hora_servidor);
  } catch (err) {
    console.error("❌ Error al conectar con la DB:", err.message);
  }

  console.log("⏰ Iniciando cron job...");
  // Ejecuta cada 5 segundos (antes era cada 2)
  cron.schedule("*/5 * * * * *", checkEndedAuctions);
});
