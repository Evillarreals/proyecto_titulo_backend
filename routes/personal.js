const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const bcrypt = require("bcrypt");

// Si ya tienes estos middlewares, se usan cuando NO es bootstrap
const { auth, requireRole } = require("../middlewares/auth");

/**
 * Genera password temporal simple (8 chars).
 * Puedes cambiarlo si quieres algo más complejo.
 */
function generateTempPassword(length = 8) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/**
 * True si tabla personal está vacía
 */
async function isPersonalEmpty() {
  const [rows] = await pool.query("SELECT COUNT(*) AS total FROM personal");
  return Number(rows?.[0]?.total || 0) === 0;
}

/**
 * Middleware: permite crear primer usuario si DB vacía + bootstrap key válida.
 * Si ya hay usuarios, exige JWT + rol administradora.
 */
async function bootstrapOrAdmin(req, res, next) {
  try {
    const empty = await isPersonalEmpty();

    if (empty) {
      const configuredKey = process.env.BOOTSTRAP_KEY;

      if (!configuredKey) {
        return res.status(500).json({
          message: "BOOTSTRAP_KEY no configurada en el servidor",
        });
      }

      const provided = req.headers["x-bootstrap-key"]; // ojo: express normaliza a minúsculas

      if (!provided) {
        return res.status(401).json({
          message: "Falta header x-bootstrap-key para crear el primer usuario",
        });
      }

      if (String(provided).trim() !== String(configuredKey).trim()) {
        return res.status(403).json({
          message: "Bootstrap key inválida",
        });
      }

      // OK: primer usuario autorizado sin JWT
      return next();
    }

    // Ya hay usuarios: requiere admin normal
    return auth(req, res, () => requireRole("administradora")(req, res, next));
  } catch (error) {
    return res.status(500).json({
      message: "Error validando bootstrap",
      error: error.message,
    });
  }
}

/**
 * POST /personal
 * - Primer usuario: bootstrapOrAdmin deja pasar con x-bootstrap-key.
 * - Luego: requiere admin.
 *
 * Body esperado:
 * {
 *   "nombre": "...",
 *   "apellido": "...",
 *   "rut": "...",
 *   "direccion": "...",
 *   "telefono": "...",
 *   "email": "...",
 *   "roles": [1,2,3]
 * }
 */
router.post("/", bootstrapOrAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { nombre, apellido, rut, direccion, telefono, email, roles } = req.body;

    if (!nombre || !apellido || !rut || !email) {
      return res.status(400).json({
        message: "Campos obligatorios: nombre, apellido, rut, email",
      });
    }

    const rolesArr = Array.isArray(roles) ? roles : [];
    if (rolesArr.length === 0) {
      return res.status(400).json({
        message: "Debe enviar al menos un rol en 'roles' (ej: [1,2])",
      });
    }

    await conn.beginTransaction();

    // Validar email único
    const [dup] = await conn.query(
      "SELECT id_personal FROM personal WHERE email = ? LIMIT 1",
      [String(email).trim()]
    );
    if (dup.length > 0) {
      await conn.rollback();
      return res.status(409).json({ message: "Ya existe un personal con ese email" });
    }

    // Password temporal
    const tempPassword = generateTempPassword(8);
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    // Crear personal
    const [result] = await conn.query(
      `INSERT INTO personal
        (nombre, apellido, rut, direccion, telefono, email, activo, password_hash, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1)`,
      [
        String(nombre).trim(),
        String(apellido).trim(),
        String(rut).trim(),
        direccion ? String(direccion).trim() : "",
        telefono ? String(telefono).trim() : "",
        String(email).trim(),
        passwordHash,
      ]
    );

    const id_personal = result.insertId;

    // Insertar roles
    for (const id_rol of rolesArr) {
      await conn.query(
        "INSERT INTO rol_personal (id_personal, id_rol) VALUES (?, ?)",
        [id_personal, Number(id_rol)]
      );
    }

    await conn.commit();

    return res.status(201).json({
      message: "Personal creado",
      id_personal,
      temp_password: tempPassword,
      must_change_password: 1,
    });
  } catch (error) {
    try {
      await conn.rollback();
    } catch (_) {}
    return res.status(500).json({
      message: "Error al crear personal",
      error: error.message,
    });
  } finally {
    conn.release();
  }
});

// (Opcional) GET /personal protegido (ejemplo)
router.get("/", auth, requireRole("administradora"), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_personal, nombre, apellido, rut, direccion, telefono, email, activo, must_change_password
       FROM personal
       ORDER BY id_personal DESC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: "Error al obtener personal", error: error.message });
  }
});

module.exports = router;
