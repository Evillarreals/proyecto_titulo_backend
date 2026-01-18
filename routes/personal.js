// routes/personal.js
const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { auth, requireRole } = require("../middlewares/auth");
const bcrypt = require("bcrypt");

// ===================== Helpers =====================

function normalizeRolesInput(roles) {
  if (!Array.isArray(roles)) return [];
  const ids = roles
    .map((r) => (typeof r === "object" && r !== null ? r.id_rol : r))
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v > 0);
  return [...new Set(ids)];
}

async function rolesExist(conn, roleIds) {
  if (roleIds.length === 0) return false;
  const [rows] = await conn.query(
    `SELECT id_rol FROM rol WHERE id_rol IN (${roleIds.map(() => "?").join(",")})`,
    roleIds
  );
  return rows.length === roleIds.length;
}

function generateTempPassword(length = 10) {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const nums = "23456789";
  const symbols = "@#$%";
  const all = upper + lower + nums + symbols;

  const pick = (s) => s[Math.floor(Math.random() * s.length)];
  let pwd = pick(upper) + pick(lower) + pick(nums) + pick(symbols);

  for (let i = pwd.length; i < length; i++) pwd += pick(all);
  pwd = pwd.split("").sort(() => Math.random() - 0.5).join("");
  return pwd;
}

async function isPersonalEmpty() {
  const [rows] = await pool.query("SELECT COUNT(*) AS c FROM personal");
  return Number(rows?.[0]?.c || 0) === 0;
}

// Middleware: SOLO permite crear sin token si NO hay personal y viene x-bootstrap-key válido.
// Si ya existe personal, exige auth + rol administradora.
async function bootstrapOrAdmin(req, res, next) {
  try {
    const empty = await isPersonalEmpty();

    // Si NO está vacía, exige token + rol
    if (!empty) {
      return auth(req, res, () =>
        requireRole("administradora")(req, res, next)
      );
    }

    // Si está vacía, valida bootstrap key
    const serverKey = process.env.BOOTSTRAP_KEY;
    if (!serverKey) {
      return res.status(500).json({
        message: "BOOTSTRAP_KEY no configurada en el backend",
      });
    }

    const sentKey = req.get("x-bootstrap-key"); // header
    if (!sentKey || sentKey !== serverKey) {
      return res.status(401).json({
        message: "Bootstrap key inválida o ausente",
      });
    }

    // OK: permite continuar sin token
    return next();
  } catch (err) {
    return res.status(500).json({
      message: "Error validando bootstrap",
      error: String(err),
    });
  }
}

// Middlewares de seguridad para rutas normales
const adminOnly = [auth, requireRole("administradora")];

// ===================== GETS =====================

// GET /personal -> activos + inactivos + roles
router.get("/", ...adminOnly, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        p.id_personal,
        p.nombre,
        p.apellido,
        p.rut,
        p.direccion,
        p.telefono,
        p.email,
        p.activo,
        p.must_change_password,
        COALESCE(
          JSON_ARRAYAGG(
            CASE 
              WHEN r.id_rol IS NULL THEN NULL
              ELSE JSON_OBJECT('id_rol', r.id_rol, 'nombre', r.nombre)
            END
          ),
          JSON_ARRAY()
        ) AS roles
      FROM personal p
      LEFT JOIN rol_personal rp ON rp.id_personal = p.id_personal
      LEFT JOIN rol r ON r.id_rol = rp.id_rol
      GROUP BY p.id_personal
      ORDER BY p.id_personal DESC
    `);

    const normalized = rows.map((p) => ({
      ...p,
      roles: Array.isArray(p.roles) ? p.roles.filter((x) => x !== null) : [],
    }));

    res.json(normalized);
  } catch (error) {
    res.status(500).json({ message: "Error al obtener personal", error: error.message });
  }
});

// GET /personal/:id -> uno + roles
router.get("/:id", ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.query(
      `
      SELECT 
        p.id_personal,
        p.nombre,
        p.apellido,
        p.rut,
        p.direccion,
        p.telefono,
        p.email,
        p.activo,
        p.must_change_password,
        COALESCE(
          JSON_ARRAYAGG(
            CASE 
              WHEN r.id_rol IS NULL THEN NULL
              ELSE JSON_OBJECT('id_rol', r.id_rol, 'nombre', r.nombre)
            END
          ),
          JSON_ARRAY()
        ) AS roles
      FROM personal p
      LEFT JOIN rol_personal rp ON rp.id_personal = p.id_personal
      LEFT JOIN rol r ON r.id_rol = rp.id_rol
      WHERE p.id_personal = ?
      GROUP BY p.id_personal
      LIMIT 1
    `,
      [id]
    );

    if (rows.length === 0) return res.status(404).json({ message: "Personal no encontrado" });

    const row = rows[0];
    row.roles = Array.isArray(row.roles) ? row.roles.filter((x) => x !== null) : [];

    res.json(row);
  } catch (error) {
    res.status(500).json({ message: "Error al obtener personal", error: error.message });
  }
});

// ===================== POST =====================

// POST /personal
// - Si la tabla personal está vacía => permite crear con x-bootstrap-key (sin token)
// - Si ya hay personal => requiere token + rol administradora
router.post("/", bootstrapOrAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { nombre, apellido, rut, direccion, telefono, email, roles } = req.body;
    const roleIds = normalizeRolesInput(roles);

    if (!nombre || !apellido || !rut || !telefono || !email) {
      return res.status(400).json({
        message: "Campos obligatorios: nombre, apellido, rut, telefono, email, roles",
      });
    }
    if (roleIds.length === 0) {
      return res.status(400).json({ message: "Debes asignar al menos 1 rol (roles)" });
    }

    await conn.beginTransaction();

    const okRoles = await rolesExist(conn, roleIds);
    if (!okRoles) {
      await conn.rollback();
      return res.status(400).json({ message: "Uno o más roles no existen" });
    }

    // clave temporal + hash + must_change_password
    const password_temporal = generateTempPassword(10);
    const password_hash = await bcrypt.hash(password_temporal, 10);

    const [result] = await conn.query(
      `INSERT INTO personal (nombre, apellido, rut, direccion, telefono, email, activo, password_hash, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1)`,
      [
        String(nombre).trim(),
        String(apellido).trim(),
        String(rut).trim(),
        direccion ? String(direccion).trim() : null,
        String(telefono).trim(),
        String(email).trim(),
        password_hash,
      ]
    );

    const id_personal = result.insertId;

    const values = roleIds.map((id_rol) => [id_personal, id_rol]);
    await conn.query("INSERT INTO rol_personal (id_personal, id_rol) VALUES ?", [values]);

    await conn.commit();

    res.status(201).json({
      message: "Personal creado y roles asignados. Clave temporal generada.",
      id_personal,
      roles: roleIds,
      password_temporal,
      must_change_password: 1,
    });
  } catch (error) {
    try { await conn.rollback(); } catch {}
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "RUT o EMAIL ya existe en el sistema" });
    }
    res.status(500).json({ message: "Error al crear personal", error: error.message });
  } finally {
    conn.release();
  }
});

// ===================== PUTS =====================

// PUT /personal/:id -> actualizar datos (NO toca activo, NO toca roles)
router.put("/:id", ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, apellido, rut, direccion, telefono, email } = req.body;

    if (!nombre || !apellido || !rut || !telefono || !email) {
      return res.status(400).json({
        message: "Campos obligatorios: nombre, apellido, rut, telefono, email",
      });
    }

    const [result] = await pool.query(
      `UPDATE personal
       SET nombre = ?, apellido = ?, rut = ?, direccion = ?, telefono = ?, email = ?
       WHERE id_personal = ?`,
      [
        String(nombre).trim(),
        String(apellido).trim(),
        String(rut).trim(),
        direccion ? String(direccion).trim() : null,
        String(telefono).trim(),
        String(email).trim(),
        id,
      ]
    );

    if (result.affectedRows === 0) return res.status(404).json({ message: "Personal no encontrado" });

    res.json({ message: "Personal actualizado" });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "RUT o EMAIL ya existe en el sistema" });
    }
    res.status(500).json({ message: "Error al actualizar personal", error: error.message });
  }
});

// PUT /personal/:id/roles -> reemplazar roles
router.put("/:id/roles", ...adminOnly, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const roleIds = normalizeRolesInput(req.body.roles);

    if (roleIds.length === 0) {
      return res.status(400).json({ message: "Debes asignar al menos 1 rol (roles)" });
    }

    await conn.beginTransaction();

    const [p] = await conn.query("SELECT id_personal FROM personal WHERE id_personal = ?", [id]);
    if (p.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Personal no encontrado" });
    }

    const okRoles = await rolesExist(conn, roleIds);
    if (!okRoles) {
      await conn.rollback();
      return res.status(400).json({ message: "Uno o más roles no existen" });
    }

    await conn.query("DELETE FROM rol_personal WHERE id_personal = ?", [id]);

    const values = roleIds.map((id_rol) => [Number(id), id_rol]);
    await conn.query("INSERT INTO rol_personal (id_personal, id_rol) VALUES ?", [values]);

    await conn.commit();
    res.json({ message: "Roles actualizados", roles: roleIds });
  } catch (error) {
    try { await conn.rollback(); } catch {}
    res.status(500).json({ message: "Error al actualizar roles", error: error.message });
  } finally {
    conn.release();
  }
});

// PUT /personal/:id/activar -> reactivar
router.put("/:id/activar", ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.query(
      `UPDATE personal SET activo = 1
       WHERE id_personal = ? AND activo = 0`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Personal no encontrado o ya está activo" });
    }

    res.json({ message: "Personal reactivado" });
  } catch (error) {
    res.status(500).json({ message: "Error al reactivar personal", error: error.message });
  }
});

// DELETE /personal/:id -> desactivar (soft delete)
router.delete("/:id", ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.query(
      `UPDATE personal SET activo = 0
       WHERE id_personal = ? AND activo = 1`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Personal no encontrado o ya está inactivo" });
    }

    res.json({ message: "Personal desactivado" });
  } catch (error) {
    res.status(500).json({ message: "Error al desactivar personal", error: error.message });
  }
});

module.exports = router;
