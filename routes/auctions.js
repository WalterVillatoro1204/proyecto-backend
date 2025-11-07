import express from "express";
import { db } from "../db.js";
import { verifyToken } from "./users.js";

const router = express.Router();

// ============================================================
// 🟢 Obtener todas las subastas
// ============================================================
router.get("/", async (req, res) => {
  try {
    const [auctions] = await db.query(`
      SELECT 
        a.*, 
        u.username AS owner_username, 
        f.name AS flagname
      FROM auctions a
      JOIN users u ON a.id_users = u.id_users
      JOIN flags f ON a.id_flags = f.id_flags
      ORDER BY a.id_auctions DESC
    `);

    res.json(auctions);
  } catch (err) {
    console.error("❌ Error al obtener subastas:", err);
    res.status(500).json({ error: "Error al obtener subastas" });
  }
});

// ============================================================
// 🟢 Obtener una subasta por ID (detalle con pujas)
// ============================================================
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    const [auctionRows] = await db.query(
      `
      SELECT 
        a.*, 
        u.username AS owner_username, 
        f.name AS flagname
      FROM auctions a
      JOIN users u ON a.id_users = u.id_users
      JOIN flags f ON a.id_flags = f.id_flags
      WHERE a.id_auctions = ?
      `,
      [id]
    );

    if (auctionRows.length === 0) {
      return res.status(404).json({ error: "Subasta no encontrada" });
    }

    const auction = auctionRows[0];

    // Obtener historial de pujas
    const [bids] = await db.query(
      `
      SELECT 
        b.*, 
        u.username 
      FROM bids b
      JOIN users u ON b.id_users = u.id_users
      WHERE b.id_auctions = ?
      ORDER BY b.bid_amount DESC
      `,
      [id]
    );

    auction.bids = bids;
    res.json(auction);
  } catch (err) {
    console.error("❌ Error al obtener subasta:", err);
    res.status(500).json({ error: "Error al obtener subasta" });
  }
});

// ============================================================
// 🟢 Crear una nueva subasta (ajuste horario UTC)
// ============================================================
router.post("/", verifyToken, async (req, res) => {
  try {
    const {
      title,
      brand,
      model,
      years,
      base_price,
      descriptions,
      start_time,
      end_time,
      image_data,
    } = req.body;

    // Validar campos obligatorios
    if (
      !title ||
      !brand ||
      !model ||
      !years ||
      !base_price ||
      !start_time ||
      !end_time
    ) {
      return res.status(400).json({
        error:
          "Faltan campos obligatorios (title, brand, model, years, base_price, start_time, end_time)",
      });
    }

    // Validar formato de fechas
    const localStart = new Date(start_time);
    const localEnd = new Date(end_time);

    if (isNaN(localStart) || isNaN(localEnd)) {
      return res.status(400).json({ error: "Formato de fecha inválido" });
    }

    // Ajustar +6h para guardar en UTC (Guatemala = UTC-6)
    const utcStart = new Date(localStart.getTime() + 6 * 60 * 60 * 1000);
    const utcEnd = new Date(localEnd.getTime() + 6 * 60 * 60 * 1000);

    const id_users = req.user.id; // viene del token
    const id_flags = 1; // por defecto “active”

    // 🧩 Guardar subasta
    await db.query(
      `
      INSERT INTO auctions 
      (id_users, id_flags, title, brand, model, years, base_price, descriptions, start_time, end_time, image_data, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
      `,
      [
        id_users,
        id_flags,
        title,
        brand,
        model,
        years,
        base_price,
        descriptions,
        utcStart,
        utcEnd,
        image_data,
      ]
    );

    console.log("✅ Subasta creada con fechas UTC:", {
      utcStart,
      utcEnd,
    });

    res
      .status(201)
      .json({ message: "✅ Subasta creada correctamente (guardada en UTC)" });
  } catch (err) {
    console.error("❌ Error al crear la subasta:", err);
    res.status(500).json({ error: "Error al crear la subasta" });
  }
});

// ============================================================
// 🟢 Actualizar estado de subasta (finalizar o modificar)
// ============================================================
router.put("/:id/status", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    await db.query("UPDATE auctions SET status = ? WHERE id_auctions = ?", [
      status,
      id,
    ]);

    res.json({ message: "Estado de subasta actualizado correctamente" });
  } catch (err) {
    console.error("❌ Error al actualizar estado:", err);
    res.status(500).json({ error: "Error al actualizar estado" });
  }
});

export default router;
