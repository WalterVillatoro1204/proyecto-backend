// ==============================================
//  ROUTES/AUCTIONS.JS - SIMPLIFICADO SIN FLAGS
// ==============================================

import express from "express";
import { db } from "../db.js";
import { verifyToken } from "./users.js";

const router = express.Router();

// ============================================================
// 🟢 Obtener todas las subastas (SIMPLIFICADO)
// ============================================================
router.get("/", async (req, res) => {
  try {
    const [auctions] = await db.query(`
      SELECT 
        a.*, 
        u.username AS owner_username
      FROM auctions a
      JOIN users u ON a.id_users = u.id_users
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
        UNIX_TIMESTAMP(a.end_time) as end_time_unix
      FROM auctions a
      JOIN users u ON a.id_users = u.id_users
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
// 🟢 Crear una nueva subasta
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
    const startDate = new Date(start_time);
    const endDate = new Date(end_time);

    if (isNaN(startDate) || isNaN(endDate)) {
      return res.status(400).json({ error: "Formato de fecha inválido" });
    }

    // Validar que end_time sea mayor que start_time
    if (endDate <= startDate) {
      return res.status(400).json({ 
        error: "La fecha de finalización debe ser posterior a la fecha de inicio" 
      });
    }

    const id_users = req.user.id;
    const id_flags = 1; // por defecto "active"

    // Guardar subasta (sin conversión manual de fechas)
    const [result] = await db.query(
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
        start_time,
        end_time,
        image_data,
      ]
    );

    console.log("✅ Subasta creada:", {
      id: result.insertId,
      title,
      start_time,
      end_time,
    });

    res.status(201).json({ 
      message: "✅ Subasta creada correctamente",
      id_auctions: result.insertId,
      start_time,
      end_time
    });
  } catch (err) {
    console.error("❌ Error al crear la subasta:", err);
    res.status(500).json({ error: "Error al crear la subasta" });
  }
});

// ============================================================
// 🟢 Actualizar estado de subasta
// ============================================================
router.put("/:id/status", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // Validar que el usuario sea el dueño de la subasta
    const [auction] = await db.query(
      "SELECT id_users FROM auctions WHERE id_auctions = ?",
      [id]
    );

    if (auction.length === 0) {
      return res.status(404).json({ error: "Subasta no encontrada" });
    }

    if (auction[0].id_users !== req.user.id) {
      return res.status(403).json({ 
        error: "No tienes permiso para modificar esta subasta" 
      });
    }

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

// ============================================================
// 🟢 Eliminar una subasta (solo si no tiene pujas)
// ============================================================
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que el usuario sea el dueño
    const [auction] = await db.query(
      "SELECT id_users FROM auctions WHERE id_auctions = ?",
      [id]
    );

    if (auction.length === 0) {
      return res.status(404).json({ error: "Subasta no encontrada" });
    }

    if (auction[0].id_users !== req.user.id) {
      return res.status(403).json({ 
        error: "No tienes permiso para eliminar esta subasta" 
      });
    }

    // Verificar que no tenga pujas
    const [bids] = await db.query(
      "SELECT COUNT(*) as count FROM bids WHERE id_auctions = ?",
      [id]
    );

    if (bids[0].count > 0) {
      return res.status(400).json({ 
        error: "No se puede eliminar una subasta que ya tiene pujas" 
      });
    }

    await db.query("DELETE FROM auctions WHERE id_auctions = ?", [id]);

    res.json({ message: "Subasta eliminada correctamente" });
  } catch (err) {
    console.error("❌ Error al eliminar subasta:", err);
    res.status(500).json({ error: "Error al eliminar subasta" });
  }
});

export default router;