import express from "express";
import multer from "multer";
import { db } from "../db.js";
import { verifyToken } from "./users.js";

export default (io) => {
    const router = express.Router();
    const storage = multer.memoryStorage();
    const upload = multer({ storage });

    // Middleware para agregar `io` a cada request
    router.use((req, res, next) => {
      req.io = io;
      next();
    });

  // Obtener todas las subastas
  router.get("/:id", async (req, res) => {
    try {
      const { id } = req.params;

      // Consulta subasta con sus pujas
      const [auctionRows] = await db.query(
        `SELECT * FROM auctions WHERE id_auctions = ?`,
        [id]
      );

      if (auctionRows.length === 0) {
        return res.status(404).json({ message: "Subasta no encontrada" });
      }

      const auction = auctionRows[0];

      const [bidRows] = await db.query(
        `SELECT b.bid_amount, u.username
        FROM bids b
        JOIN users u ON b.id_users = u.id_users
        WHERE b.id_auctions = ?
        ORDER BY b.bid_amount DESC`,
        [id]
      );

      auction.bids = bidRows;

      res.json(auction);
    } catch (err) {
      console.error("❌ Error al obtener subasta:", err);
      res.status(500).json({ error: "Error al obtener subasta" });
    }
  });

  // Crear nueva subasta y notificar a los demás
  router.post("/", verifyToken, async (req, res) => {
    try {
      const {
        title,
        brand,
        model,
        years,
        description,
        base_price,
        start_time,
        end_time,
        image_data
      } = req.body;

      // =====================================================
      // 🕓 Convertir hora local (del navegador) a UTC
      // =====================================================
      if (!start_time || !end_time) {
        return res.status(400).json({ error: "start_time y end_time son requeridos" });
      }

      // 🕒 Convertir fechas locales a UTC
      const localStart = new Date(start_time);
      const localEnd = new Date(end_time);

      // Verificar que son válidas
      if (isNaN(localStart) || isNaN(localEnd)) {
        return res.status(400).json({ error: "Formato de fecha inválido" });
      }

      // Ajustar zona horaria: Guatemala UTC-6 → UTC
      const utcStart = new Date(localStart.getTime() + 6 * 60 * 60 * 1000);
      const utcEnd = new Date(localEnd.getTime() + 6 * 60 * 60 * 1000);

      // 🧩 Guardar subasta con las fechas en UTC
      await db.query(
        `INSERT INTO auctions (title, brand, model, years, base_price, descriptions, start_time, end_time, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [title, brand, model, years, base_price, descriptions, utcStart, utcEnd]
      );

      console.log("✅ Subasta creada con:", { utcStart, utcEnd });


      res.status(201).json({ message: "✅ Subasta creada correctamente (guardada en UTC)" });

    } catch (err) {
      console.error("❌ Error al crear la subasta:", err);
      res.status(500).json({ message: "Error al crear la subasta" });
    }
  });

  // Obtener subasta por ID
  router.get("/:id", async (req, res) => {
    const { id } = req.params;
    try {
      const [auctionRows] = await db.query(
        `
        SELECT a.*, u.username AS owner_username, f.flagname
          FROM auctions a
          JOIN users u ON a.id_users = u.id_users
          JOIN flags f ON a.id_flags = f.id_flags
         WHERE a.id_auctions = ?
        `,
        [id]
      );

      if (auctionRows.length === 0)
        return res.status(404).json({ message: "Subasta no encontrada" });

      const auction = auctionRows[0];
      auction.image_data = auction.image_data
        ? `data:image/jpeg;base64,${auction.image_data.toString("base64")}`
        : null;

      const [bids] = await db.query(
        `
        SELECT b.bid_amount, b.bid_time, u.username
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
      console.error("Error al obtener subasta:", err);
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}
