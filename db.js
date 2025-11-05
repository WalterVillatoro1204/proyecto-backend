import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

export const db = await mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: "-06:00",
});

// Verificar conexión al iniciar
try {
  const [rows] = await db.query("SELECT NOW() AS now");
  console.log(`✅ Conectado a la base de datos (${process.env.DB_HOST}) - Hora:`, rows[0].now);
} catch (err) {
  console.error("❌ Error al conectar a la base de datos:", err.message);
  process.exit(1);
}