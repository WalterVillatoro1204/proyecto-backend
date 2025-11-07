// server.js
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

// 🔧 offset fijo de Guatemala respecto a UTC
const LOCAL_OFFSET_HOURS = 6; // Guatemala = UTC-6

/* ======================================================
🌎 AJUSTE DE ZONA HORARIA (best-effort)
====================================================== */
async function setTimezone() {
  try {
    // Muchos RDS no permiten cambiar GLOBAL; si falla, no pasa nada.
    await db.query("SET time_zone = '+00:00'");
    const [result] = await db.query(
      "SELECT NOW() as now_utc, @@session.time_zone as session_tz"
    );
    console.log("🕓 Sesión MySQL:");
    console.log("   Zona:", result[0].session_tz);
    console.log("   NOW():", result[0].now_utc);
  } catch (err) {
    console.warn(
      "⚠️ No se pudo fijar time_zone de sesión (usaremos UTC explícito en las consultas):",
      err.message
    );
  }
}

/* ======================================================
🔄 FUNCIÓN: Verificar subastas finalizadas (CONSISTENTE)
====================================================== */
/*
  REGLA CLAVE:
  - end_time está guardado como hora LOCAL (Guatemala, UTC-6).
  - MySQL está en UTC.
  - Entonces: local_now = UTC_TIMESTAMP() - 6h.
  - Una subasta terminó cuando local_now >= end_time.
*/

async function checkEndedAuctions() {
  try {
    // Obtener hora UTC y hora local derivada (Guatemala)
    const [timeRow] = await db.query(`
      SELECT 
        UTC_TIMESTAMP(6)       AS utc_now,
        DATE_SUB(UTC_TIMESTAMP(6), INTERVAL ${LOCAL_OFFSET_HOURS} HOUR) AS local_now
    `);

    const utcNow = timeRow[0].utc_now;
    const localNow = timeRow[0].local_now;
    console.log(`⏰ [Cron] UTC: ${utcNow} | Local(GT): ${localNow}`);

    // Subastas activas cuyo end_time (local) ya pasó respecto a local_now
    const [auctions] = await db.query(`
      SELECT 
        id_auctions,
        title,
        end_time
      FROM auctions
      WHERE status = 'active'
        AND end_time <= UTC_TIMESTAMP()
    `);

    if (!auctions.length) return;

    for (const auction of auctions) {
      const { id_auctions, title, end_time } = auction;
      console.log(
        `\n📋 Evaluando subasta #${id_auctions} (${title}) end_time(local)=${end_time}`
      );

      // Última puja (en UTC); esto se compara en UTC, así que es consistente
      const [lastBidInfo] = await db.query(
        `
        SELECT 
          MAX(bid_time) AS last_bid_time,
          TIMESTAMPDIFF(SECOND, MAX(bid_time), UTC_TIMESTAMP()) AS seconds_since_last_bid
        FROM bids
        WHERE id_auctions = ?
      `,
        [id_auctions]
      );

      if (lastBidInfo[0].last_bid_time) {
        const secondsSinceLastBid = lastBidInfo[0].seconds_since_last_bid;
        console.log(
          `   🔔 Última puja hace ${secondsSinceLastBid}s (UTC reference)`
        );
        // Pequeña gracia de 2s para evitar cerrar mientras se inserta algo
        if (secondsSinceLastBid < 2) {
          console.log("   ⏳ Esperando más tiempo por seguridad.");
          continue;
        }
      }

      // Buscar ganador (puja más alta, desempate por más antigua)
      const [winner] = await db.query(
        `
        SELECT b.id_users, b.bid_amount, b.bid_time, u.username
        FROM bids b
        JOIN users u ON u.id_users = b.id_users
        WHERE b.id_auctions = ?
        ORDER BY b.bid_amount DESC, b.bid_time ASC
        LIMIT 1
      `,
        [id_auctions]
      );

      // Marcar subasta como finalizada (idempotente)
      await db.query(
        "UPDATE auctions SET status = 'ended' WHERE id_auctions = ?",
        [id_auctions]
      );
      console.log(
        `   🔒 Subasta #${id_auctions} marcada como 'ended' en la BD.`
      );

      if (winner.length > 0) {
        const { id_users, bid_amount, username } = winner[0];
        const formattedAmount = parseFloat(bid_amount).toLocaleString(
          "en-US",
          {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }
        );

        // Notificación GANADOR (evita duplicados)
        const winnerMessage = `🏆 🎉 ¡Felicidades ${username}! Ganaste la subasta #${id_auctions} (${title}) con una puja de $${formattedAmount}.`;

        await db.query(
          `
          INSERT INTO notifications (id_auction, id_user, message, created_at)
          SELECT ?, ?, ?, UTC_TIMESTAMP()
          WHERE NOT EXISTS (
            SELECT 1 FROM notifications
            WHERE id_auction = ? AND id_user = ? AND message LIKE '🏆 %'
          )
        `,
          [id_auctions, id_users, winnerMessage, id_auctions, id_users]
        );

        // Notificaciones PERDEDORES
        const [losers] = await db.query(
          `
          SELECT DISTINCT b.id_users, u.username
          FROM bids b
          JOIN users u ON u.id_users = b.id_users
          WHERE b.id_auctions = ? AND b.id_users != ?
        `,
          [id_auctions, id_users]
        );

        for (const loser of losers) {
          const loserMessage = `💔 Hola ${loser.username}, la subasta #${id_auctions} (${title}) finalizó. El ganador fue ${username} con una puja de $${formattedAmount}. ¡Mejor suerte en la próxima!`;

          await db.query(
            `
            INSERT INTO notifications (id_auction, id_user, message, created_at)
            SELECT ?, ?, ?, UTC_TIMESTAMP()
            WHERE NOT EXISTS (
              SELECT 1 FROM notifications
              WHERE id_auction = ? AND id_user = ? AND message LIKE '💔 %'
            )
          `,
            [
              id_auctions,
              loser.id_users,
              loserMessage,
              id_auctions,
              loser.id_users,
            ]
          );
        }

        console.log(
          `   📨 Notificaciones enviadas: 1 ganador + ${losers.length} perdedores`
        );

        // Evento en tiempo real
        io.emit("auctionEnded", {
          id_auctions,
          winner: username,
          bid_amount,
        });
      } else {
        // Sin pujas
        const msg = `😢 Nadie ofertó en la subasta #${id_auctions} (${title}).`;

        await db.query(
          `
          INSERT INTO notifications (id_auction, id_user, message, created_at)
          SELECT ?, NULL, ?, UTC_TIMESTAMP()
          WHERE NOT EXISTS (
            SELECT 1 FROM notifications
            WHERE id_auction = ? AND message LIKE '😢 Nadie%'
          )
        `,
          [id_auctions, msg, id_auctions]
        );

        io.emit("auctionEnded", {
          id_auctions,
          winner: null,
          bid_amount: null,
        });

        console.log("   🚫 Subasta sin pujas, notificación creada.");
      }
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
app.use(
  cors({
    origin: [
      "https://www.mycarbid.click",
      "https://mycarbid.click",
      "https://main.d3rcj7yl7zv9wm.amplifyapp.com",
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
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
      console.log("⚠️ Cliente conectado sin token (visitante)");
      socket.username = "visitante";
      return next();
    }

    const decoded = jwt.verify(token, secret);
    socket.userId = decoded.id;
    socket.username = decoded.username;
    socket.join(`user_${decoded.id}`);
    console.log(`✅ Usuario autenticado en WS: ${socket.username}`);
    next();
  } catch (err) {
    console.error("❌ Token inválido:", err.message);
    return next(new Error("Token inválido"));
  }
});

/* ======================================================
💬 EVENTOS DE PUJA (Socket) — validación con misma TZ
====================================================== */
io.on("connection", (socket) => {
  socket.on("newBid", async (bidData) => {
    try {
      const { token, id_auctions, bid_amount } = bidData;
      if (!token)
        return socket.emit("errorBid", { message: "Token requerido." });

      let decoded;
      try {
        decoded = jwt.verify(token, secret);
      } catch {
        return socket.emit("errorBid", {
          message: "Token inválido o expirado.",
        });
      }

      const userId = decoded.id;
      const auctionId = Number(id_auctions);
      const amount = Number(bid_amount);

      if (!auctionId || isNaN(amount) || amount <= 0) {
        return socket.emit("errorBid", { message: "Monto inválido." });
      }

      // Traer subasta + cuánto falta según hora LOCAL derivada
      const [auctionRows] = await db.query(
        `
        SELECT 
          CAST(base_price AS DECIMAL(10,2)) AS base_price,
          end_time,
          status,
          TIMESTAMPDIFF(
            SECOND,
            DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${LOCAL_OFFSET_HOURS} HOUR),
            end_time
          ) AS seconds_to_end_local
        FROM auctions
        WHERE id_auctions = ?
      `,
        [auctionId]
      );

      if (!auctionRows.length) {
        return socket.emit("errorBid", {
          message: "Subasta no encontrada.",
        });
      }

      const {
        base_price,
        status,
        seconds_to_end_local,
      } = auctionRows[0];

      // Si ya terminó según hora local, o ya está marcada como ended
      if (status === "ended" || seconds_to_end_local <= 0) {
        return socket.emit("errorBid", {
          message: "La subasta ya ha finalizado.",
        });
      }

      const basePrice = parseFloat(base_price || "0");

      // Obtener puja más alta actual
      const [maxRows] = await db.query(
        `
        SELECT bid_amount
        FROM bids
        WHERE id_auctions = ?
        ORDER BY bid_amount DESC
        LIMIT 1
      `,
        [auctionId]
      );

      const highestBid = maxRows.length
        ? parseFloat(maxRows[0].bid_amount || 0)
        : 0;

      const threshold = Math.max(basePrice, highestBid);

      if (amount <= threshold) {
        return socket.emit("errorBid", {
          message: `La puja mínima debe ser mayor a $${threshold.toLocaleString(
            "en-US",
            {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }
          )}.`,
        });
      }

      // Registrar puja
      await db.query(
        `
        INSERT INTO bids (id_auctions, id_users, bid_amount)
        VALUES (?, ?, ?)
      `,
        [auctionId, userId, amount]
      );

      console.log(
        `✅ Puja registrada: ${decoded.username} -> #${auctionId} $${amount}`
      );

      // Recalcular mejor oferta
      const [highest] = await db.query(
        `
        SELECT b.bid_amount, u.username
        FROM bids b
        JOIN users u ON u.id_users = b.id_users
        WHERE b.id_auctions = ?
        ORDER BY b.bid_amount DESC, b.bid_time ASC
        LIMIT 1
      `,
        [auctionId]
      );

      io.emit("updateBids", {
        id_auctions: auctionId,
        highestBid: parseFloat(highest[0].bid_amount),
        highestBidUser: highest[0].username,
      });
    } catch (err) {
      console.error("❌ Error al registrar la puja:", err);
      socket.emit("errorBid", {
        message: "Error interno al registrar la puja.",
      });
    }
  });
});

/* ======================================================
🚀 INICIAR SERVIDOR
====================================================== */
server.listen(PORT, async () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);

  await setTimezone();

  try {
    const [rows] = await db.query("SELECT UTC_TIMESTAMP() AS utc_now");
    console.log("🕒 UTC ahora en MySQL:", rows[0].utc_now);
  } catch (err) {
    console.error("❌ Error al leer hora MySQL:", err.message);
  }

  console.log("⏰ Iniciando cron job de subastas...");
  // cada 2 segundos para pruebas (ajusta si quieres)
  cron.schedule("*/2 * * * * *", checkEndedAuctions);
});