import express, { json } from "express";
import { db } from "../db.js";
import bcrypt, { compare } from "bcryptjs";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";

dotenv.config();
const router = express.Router();

const secret = process.env.JWT_SECRET;

// Registro de usuario
router.post("/register", async (req, res) => {
  const { username, password } = req.body;
  try {
    if (!username || !password) {
      return res.status(400).json({ message: "Usuario y contraseña requeridos" });
    }

    // Verificar si el usuario ya existe
    const [existingUser] = await db.query("SELECT * FROM users WHERE username = ?", [username]);
    if (existingUser.length > 0) {
      return res.status(409).json({ message: "El usuario ya existe" });
    }

    // Hashear la contraseña
    const hashedPassword = await bcrypt.hash(password, 11);

    // Insertar el nuevo usuario
    const [result] = await db.query(
      "INSERT INTO users (username, password_hash) VALUES (?, ?)",
      [username, hashedPassword]
    );

    res.status(201).json({
      message: "Usuario registrado con éxito",
      id: result.insertId,
      username
    });
  } catch (err) {
    console.error("❌ Error al registrar usuario:", err);
    res.status(500).json({ error: err.message });
  }
});


// Login de usuario
router.post("/login", async (req, res) => {
  console.log("📥 Request recibido en /login");
  console.log("📥 Headers:", req.headers);
  console.log("📥 Body recibido:", req.body);

  try {
    const { username, password } = req.body;
    if (!username || !password) {
      console.log("❌ Falta usuario o contraseña");
      return res.status(400).json({ message: "Datos incompletos" });
    }

    const [rows] = await db.query("SELECT * FROM users WHERE username = ?", [username]);
    if (rows.length === 0) {
      console.log("❌ Usuario no encontrado");
      return res.status(401).json({ message: "Usuario no encontrado" });
    }

    const user = rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      console.log("❌ Contraseña incorrecta");
      return res.status(401).json({ message: "Credenciales incorrectas" });
    }

    const token = jwt.sign(
      { id: user.id_users, username: user.username },
      secret,
      { expiresIn: "1h" }
    );

    console.log(`✅ Login exitoso para usuario ${username}`);

    return res.json({
      message: "Login exitoso",
      token,
      user: {
        id_users: user.id_users,
        username: user.username,
      },
    });
  } catch (error) {
    console.error("💥 Error en login:", error);
    return res.status(500).json({ message: "Error interno en el servidor" });
  }
});

router.get("/information", verifyToken, async (req, res) => {
    res.json({ message: "Acceso Autorizado", user: req.user });
});

export function verifyToken(req, res, next) {
    const authheader = req.headers["authorization"];
    const token = authheader && authheader.split(" ")[1];

    if (!token) return res.status(403).json({ message: "Token Requerido" });

    jwt.verify(token, secret, (err, user) => {
        if (err) return res.status(403).json({ message: "Token inválido o expirado" });
        req.user = user;
        next();
    });
}

export default router;
