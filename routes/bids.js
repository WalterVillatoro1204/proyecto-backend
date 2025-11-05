// 📁 routes/bids.js
import express from "express";
import { db } from "../db.js";
import { verifyToken } from "./users.js"; // ✅ Middleware para validar JWT

const router = express.Router();

// ============================================================
// 🟢 Crear una nueva puja (validación segura y sincronizada con el socket)
// ============================================================
router.post("/", verifyToken, async (req, res) => {
  const { id_auctions, bid_amount } = req.body;
  const userId = req.user.id;

  try {
    // 1️⃣ Verificar que la subasta exista y esté activa
    const [auction] = await db.query(
      `SELECT base_price, end_time, status FROM auctions WHERE id_auctions = ?`,
      [id_auctions]
    );

    if (auction.length === 0) {
      return res.status(404).json({ message: "Subasta no encontrada." });
    }

    const { base_price, end_time, status } = auction[0];
    const basePrice = parseFloat(base_price);
    const now = new Date();

    if (status === "ended" || now >= new Date(end_time)) {
      return res.status(400).json({
        message: "⛔ La subasta ya ha finalizado. No se pueden realizar más pujas.",
      });
    }

    if (isNaN(bid_amount) || bid_amount <= 0) {
      return res.status(400).json({ message: "Monto de puja inválido." });
    }

    // 2️⃣ Obtener la puja más alta actual (si existe)
    const [currentBid] = await db.query(
      `SELECT bid_amount FROM bids WHERE id_auctions = ? ORDER BY bid_amount DESC LIMIT 1`,
      [id_auctions]
    );

    const highestBid = currentBid.length ? parseFloat(currentBid[0].bid_amount) : 0;
    const threshold = Math.max(basePrice, highestBid);

    // 3️⃣ Validar monto mínimo permitido
    if (bid_amount <= threshold) {
      return res.status(400).json({
        message: `⛔ La puja mínima debe ser mayor a $${threshold.toFixed(2)}.`,
      });
    }

    // 4️⃣ Insertar la puja en la base de datos
    const [result] = await db.query(
      `INSERT INTO bids (id_auctions, id_users, bid_amount) VALUES (?, ?, ?)`,
      [id_auctions, userId, bid_amount]
    );

    console.log(`✅ Nueva puja registrada: user=${userId} | auction=${id_auctions} | monto=$${bid_amount}`);

    return res.status(201).json({
      message: "✅ Puja registrada correctamente",
      id_bids: result.insertId,
      bid_amount,
    });
  } catch (err) {
    console.error("❌ Error al registrar la puja:", err.message);
    return res.status(500).json({ message: "Error interno al registrar la puja" });
  }
});

// ============================================================
// 📜 Obtener historial de pujas del usuario autenticado
// ============================================================
router.get("/history", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [rows] = await db.query(
      `
      SELECT 
        a.id_auctions,
        a.title,
        a.brand,
        a.model,
        a.years,
        a.image_data,
        MAX(b.bid_amount) AS bid_amount,
        a.start_time,
        a.end_time,
        a.status,
        CASE
          WHEN a.status = 'ended' THEN 'Finalizada'
          WHEN NOW() < a.end_time THEN 'Activa'
          ELSE 'Finalizada'
        END AS status_text
      FROM bids b
      JOIN auctions a ON a.id_auctions = b.id_auctions
      WHERE b.id_users = ?
      GROUP BY 
        a.id_auctions, a.title, a.brand, a.model, a.years, 
        a.image_data, a.start_time, a.end_time, a.status
      ORDER BY a.end_time DESC;
      `,
      [userId]
    );

    // ✅ CLAVE: Convertir image_data (Buffer) a base64
    const auctionsWithImages = rows.map((row) => {
      let imageBase64 = null;

      if (row.image_data) {
        if (Buffer.isBuffer(row.image_data)) {
          imageBase64 = `data:image/jpeg;base64,${row.image_data.toString("base64")}`;
        } else if (row.image_data.data) {
          // caso: { type: 'Buffer', data: [...] }
          imageBase64 = `data:image/jpeg;base64,${Buffer.from(row.image_data.data).toString("base64")}`;
        } else if (typeof row.image_data === "string") {
          // ya viene codificada
          imageBase64 = row.image_data;
        }
      }

      return {
        ...row,
        image_data: imageBase64,
      };
    });

    console.log(`📊 Historial solicitado por usuario ${userId}: ${auctionsWithImages.length} subastas`);

    return res.status(200).json(auctionsWithImages);
  } catch (err) {
    console.error("❌ Error al obtener historial:", err.message);
    return res.status(500).json({ message: "Error al obtener historial de subastas" });
  }
});

export default router;