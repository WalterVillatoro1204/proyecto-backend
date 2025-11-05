import express from "express";
import { db } from "../db.js";
import { verifyToken } from "./users.js"; // ✅ Importación correcta

const router = express.Router();

// ============================================================
// 🟢 Crear una nueva puja (validada, segura y atómica)
// ============================================================
router.post("/", verifyToken, async (req, res) => {
  const { id_auctions, bid_amount } = req.body;
  const userId = req.user.id; // ✅ viene del token JWT

  try {
    // 1️⃣ Verificar si la subasta existe y está activa
    const [auction] = await db.query(
      `SELECT end_time, base_price FROM auctions WHERE id_auctions = ?`,
      [id_auctions]
    );

    if (auction.length === 0) {
      return res.status(404).json({ message: "Subasta no encontrada." });
    }

    const endTime = new Date(auction[0].end_time);
    const now = new Date();

    if (now >= endTime) {
      return res.status(400).json({
        message: "⛔ La subasta ya ha finalizado. No se pueden realizar más pujas.",
      });
    }

    // 2️⃣ Registrar la puja si es válida (mayor que la actual)
    const [result] = await db.query(
      `
      INSERT INTO bids (id_auctions, id_users, bid_amount)
      SELECT ?, ?, ?
      FROM auctions a
      WHERE a.id_auctions = ?
        AND UTC_TIMESTAMP() < a.end_time
        AND ? > GREATEST(
              a.base_price,
              COALESCE((SELECT MAX(bid_amount) FROM bids WHERE id_auctions = a.id_auctions), 0)
            );
      `,
      [id_auctions, userId, bid_amount, id_auctions, bid_amount]
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({
        message: "⛔ Puja inválida: monto menor o igual a la actual, o subasta cerrada.",
      });
    }

    res.status(201).json({
      message: "✅ Puja registrada correctamente",
      id: result.insertId,
    });
  } catch (err) {
    console.error("❌ Error al crear puja:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// 📜 Historial de pujas del usuario autenticado
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
        MAX(b.bid_amount) AS bid_amount, -- 🔹 Solo la puja más alta del usuario
        a.start_time,
        a.end_time,
        CASE
          WHEN NOW() < a.end_time THEN 'Activa'
          ELSE 'Finalizada'
        END AS status
      FROM bids b
      JOIN auctions a ON a.id_auctions = b.id_auctions
      WHERE b.id_users = ?
      GROUP BY 
        a.id_auctions, a.title, a.brand, a.model, a.years, 
        a.image_data, a.start_time, a.end_time
      ORDER BY a.end_time DESC;
      `,
      [userId]
    );

    res.json(rows);
  } catch (err) {
    console.error("❌ Error al obtener historial:", err);
    res.status(500).json({ message: "Error al obtener historial de subastas" });
  }
});

export default router;
