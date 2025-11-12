import express from "express";
import { db } from "../db.js";
import { verifyToken } from "./users.js";

const router = express.Router();

// 📩 Obtener notificaciones del usuario autenticado
router.get("/", verifyToken, async (req, res) => {
  try {
    // ✅ Verifica si tu columna es id_user o id_users
    const [rows] = await db.query(
      `SELECT 
        id_notification, 
        id_auction, 
        message, 
        type,
        is_read, 
        created_at 
      FROM notifications 
      WHERE id_user = ? 
      ORDER BY created_at DESC 
      LIMIT 50`,
      [req.user.id]
    );
    
    console.log(`📬 ${rows.length} notificaciones para usuario ${req.user.id}`);
    
    res.json(rows);
  } catch (err) {
    console.error("❌ Error al obtener notificaciones:", err);
    res.status(500).json({ message: "Error al obtener notificaciones" });
  }
});

// 📌 Marcar notificación como leída
router.put("/:id/read", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    await db.query(
      `UPDATE notifications SET is_read = 1 WHERE id_notification = ? AND id_user = ?`,
      [id, req.user.id]
    );
    
    res.json({ success: true, message: "Notificación marcada como leída" });
  } catch (err) {
    console.error("❌ Error marcando notificación:", err);
    res.status(500).json({ message: "Error al actualizar notificación" });
  }
});

// 🗑️ Eliminar notificación
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    await db.query(
      `DELETE FROM notifications WHERE id_notification = ? AND id_user = ?`,
      [id, req.user.id]
    );
    
    res.json({ success: true, message: "Notificación eliminada" });
  } catch (err) {
    console.error("❌ Error eliminando notificación:", err);
    res.status(500).json({ message: "Error al eliminar notificación" });
  }
});

export default router;