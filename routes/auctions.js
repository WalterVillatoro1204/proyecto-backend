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
  router.get("/", async (req, res) => {
    try {
      const [rows] = await db.query(`
        SELECT a.id_auctions, a.title, a.brand, a.model, a.years, 
               a.descriptions, a.base_price, a.start_time, a.end_time,
               f.flagname, u.username, a.image_data
          FROM auctions a
          JOIN users u ON a.id_users = u.id_users
          JOIN flags f ON a.id_flags = f.id_flags
         ORDER BY a.start_time DESC
      `);

      const auctions = rows.map(row => ({
        ...row,
        image_data: row.image_data
          ? `data:image/jpeg;base64,${row.image_data.toString("base64")}`
          : null
      }));

      res.json(auctions);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Crear nueva subasta y notificar a los demás
  router.post("/", verifyToken, upload.single("image"), async (req, res) => {
    const { title, brand, model, years, descriptions, base_price, start_time, end_time } = req.body;
    const image = req.file ? req.file.buffer : null;
    const id_users = req.user.id;
    const id_flags = 1; // estado "active"

    try {
      const [result] = await db.query(
        `
        INSERT INTO auctions
        (id_users, id_flags, title, brand, model, years, descriptions, base_price, image_data, start_time, end_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [id_users, id_flags, title, brand, model, years, descriptions, base_price, image, start_time, end_time]
      );

      const newAuction = {
        id_auctions: result.insertId,
        title,
        brand,
        model,
        years,
        descriptions,
        base_price,
        start_time,
        end_time,
        image_data: image ? `data:image/jpeg;base64,${image.toString("base64")}` : null,
      };

      // Emitir evento a todos los sockets conectados
      req.io.emit("newAuction", newAuction);

      res.json({ message: "🚗 Subasta creada con éxito", auction: newAuction });
    } catch (err) {
      console.error("Error al crear subasta:", err);
      res.status(500).json({ error: err.message });
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
