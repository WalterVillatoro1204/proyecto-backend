import express from "express";
import { db } from "../db.js";
import { verifyToken } from "./users.js"; 

const router = express.Router();

// 📩 Obtener notificaciones del usuario autenticado
router.get("/", verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id_notification, id_auction, message, is_read, created_at FROM notifications WHERE id_user = ? ORDER BY created_at DESC",
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ Error al obtener notificaciones:", err);
    res.status(500).json({ message: "Error al obtener notificaciones" });
  }
});

export default router;
