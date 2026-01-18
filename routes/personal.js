const express = require('express');
const router = express.Router();

const pool = require('../config/db');
const bcrypt = require('bcrypt');
const { auth, requireRole } = require('../middlewares/auth');

// =========================
// Helpers
// =========================
function generateTempPassword(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function getPersonalCount() {
  const [rows] = await pool.query('SELECT COUNT(*) AS c FROM personal');
  return Number(rows?.[0]?.c ?? 0);
}

function runMiddleware(mw, req, res) {
  return new Promise((resolve, reject) => {
    try {
      mw(req, res, (err) => (err ? reject(err) : resolve()));
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Permite crear personal:
 * - si NO hay nadie en la tabla: exige x-bootstrap-key == BOOTSTRAP_KEY
 * - si YA hay personal: exige auth + rol administradora
 */
async function ensureCanCreatePersonal(req, res, next) {
  try {
    const count = await getPersonalCount();

    // Caso bootstrap (BD vacía)
    if (count === 0) {
      const expected = process.env.BOOTSTRAP_KEY;
      const provided = req.get('x-bootstrap-key');

      if (!expected) {
        return res.status(500).json({
          message: 'BOOTSTRAP_KEY no está configurada en el servicio',
          error: 'Missing BOOTSTRAP_KEY',
        });
      }

      if (!provided || provided !== expected) {
        return res.status(401).json({
          message: 'Bootstrap key inválida o ausente',
          error: 'Invalid bootstrap key',
        });
      }

      req._bootstrap = true;
      return next();
    }

    // Caso normal: requiere token + rol admin
    await runMiddleware(auth, req, res);
    await runMiddleware(requireRole('administradora'), req, res);
    return next();
  } catch (error) {
    return res.status(500).json({
      message: 'Error validando bootstrap',
      error: error?.message || String(error),
    });
  }
}

// =========================
// Rutas
// =========================

// GET /personal -> lista (activos e inactivos) con roles
router.get('/', auth, requireRole('administradora'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.id_personal, p.nombre, p.apellido, p.rut, p.direccion, p.telefono, p.email, p.activo, p.must_change_password
       FROM personal p
       ORDER BY p.id_personal DESC`
    );

    // roles por personal
    const ids = rows.map(r => r.id_personal);
    let rolesMap = new Map();
    if (ids.length) {
      const [roleRows] = await pool.query(
        `SELECT rp.id_personal, r.id_rol, r.nombre
         FROM rol_personal rp
         JOIN rol r ON r.id_rol = rp.id_rol
         WHERE rp.id_personal IN (${ids.map(() => '?').join(',')})`,
        ids
      );

      for (const rr of roleRows) {
        if (!rolesMap.has(rr.id_personal)) rolesMap.set(rr.id_personal, []);
        rolesMap.get(rr.id_personal).push({ id_rol: rr.id_rol, nombre: rr.nombre });
      }
    }

    const out = rows.map(p => ({
      ...p,
      roles: rolesMap.get(p.id_personal) || [],
    }));

    res.json(out);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener personal', error: error.message });
  }
});

// GET /personal/:id -> detalle con roles
router.get('/:id', auth, requireRole('administradora'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query(
      `SELECT id_personal, nombre, apellido, rut, direccion, telefono, email, activo, must_change_password
       FROM personal
       WHERE id_personal = ?`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Personal no encontrado' });

    const [roleRows] = await pool.query(
      `SELECT r.id_rol, r.nombre
       FROM rol_personal rp
       JOIN rol r ON r.id_rol = rp.id_rol
       WHERE rp.id_personal = ?`,
      [id]
    );

    res.json({ ...rows[0], roles: roleRows });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener personal', error: error.message });
  }
});

// POST /personal -> crea personal (bootstrap o admin)
router.post('/', ensureCanCreatePersonal, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { nombre, apellido, rut, direccion, telefono, email, roles } = req.body;

    if (!nombre || !apellido || !rut || !email || !Array.isArray(roles) || roles.length === 0) {
      return res.status(400).json({
        message: 'Campos obligatorios: nombre, apellido, rut, email, roles[]',
      });
    }

    // validar roles existen
    const roleIds = roles.map(n => Number(n)).filter(n => Number.isFinite(n));
    if (!roleIds.length) {
      return res.status(400).json({ message: 'roles debe ser un arreglo de id_rol (números)' });
    }

    const [validRoles] = await pool.query(
      `SELECT id_rol FROM rol WHERE id_rol IN (${roleIds.map(() => '?').join(',')})`,
      roleIds
    );
    if (validRoles.length !== roleIds.length) {
      return res.status(400).json({ message: 'Uno o más roles no existen' });
    }

    // email único
    const [exists] = await pool.query(`SELECT id_personal FROM personal WHERE email = ? LIMIT 1`, [
      String(email).trim(),
    ]);
    if (exists.length) return res.status(409).json({ message: 'Ya existe un usuario con ese email' });

    // password temporal
    const tempPassword = generateTempPassword(10);
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    await conn.beginTransaction();

    const [result] = await conn.query(
      `INSERT INTO personal (nombre, apellido, rut, direccion, telefono, email, activo, password_hash, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1)`,
      [
        String(nombre).trim(),
        String(apellido).trim(),
        String(rut).trim(),
        direccion ? String(direccion).trim() : null,
        telefono ? String(telefono).trim() : null,
        String(email).trim(),
        passwordHash,
      ]
    );

    const id_personal = result.insertId;

    // insertar roles
    for (const id_rol of roleIds) {
      await conn.query(`INSERT INTO rol_personal (id_personal, id_rol) VALUES (?, ?)`, [
        id_personal,
        id_rol,
      ]);
    }

    await conn.commit();

    res.status(201).json({
      message: req._bootstrap ? 'Usuario bootstrap creado' : 'Personal creado',
      id_personal,
      temp_password: tempPassword,
      must_change_password: 1,
    });
  } catch (error) {
    try {
      await conn.rollback();
    } catch (_) {}
    res.status(500).json({ message: 'Error al crear personal', error: error?.message || String(error) });
  } finally {
    conn.release();
  }
});

// PUT /personal/:id -> actualiza datos (NO roles)
router.put('/:id', auth, requireRole('administradora'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { nombre, apellido, rut, direccion, telefono, email, activo } = req.body;

    const [exists] = await pool.query(`SELECT id_personal FROM personal WHERE id_personal = ?`, [id]);
    if (!exists.length) return res.status(404).json({ message: 'Personal no encontrado' });

    // si cambia email, validar único
    if (email) {
      const [dup] = await pool.query(
        `SELECT id_personal FROM personal WHERE email = ? AND id_personal <> ? LIMIT 1`,
        [String(email).trim(), id]
      );
      if (dup.length) return res.status(409).json({ message: 'Ya existe otro usuario con ese email' });
    }

    await pool.query(
      `UPDATE personal
       SET nombre = COALESCE(?, nombre),
           apellido = COALESCE(?, apellido),
           rut = COALESCE(?, rut),
           direccion = COALESCE(?, direccion),
           telefono = COALESCE(?, telefono),
           email = COALESCE(?, email),
           activo = COALESCE(?, activo)
       WHERE id_personal = ?`,
      [
        nombre !== undefined ? String(nombre).trim() : null,
        apellido !== undefined ? String(apellido).trim() : null,
        rut !== undefined ? String(rut).trim() : null,
        direccion !== undefined ? (direccion ? String(direccion).trim() : null) : null,
        telefono !== undefined ? (telefono ? String(telefono).trim() : null) : null,
        email !== undefined ? String(email).trim() : null,
        activo !== undefined ? Number(activo) : null,
        id,
      ]
    );

    res.json({ message: 'Personal actualizado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar personal', error: error.message });
  }
});

// PUT /personal/:id/roles -> reemplaza roles
router.put('/:id/roles', auth, requireRole('administradora'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = Number(req.params.id);
    const { roles } = req.body;

    if (!Array.isArray(roles) || roles.length === 0) {
      return res.status(400).json({ message: 'roles[] es obligatorio' });
    }

    const roleIds = roles.map(n => Number(n)).filter(n => Number.isFinite(n));
    const [validRoles] = await pool.query(
      `SELECT id_rol FROM rol WHERE id_rol IN (${roleIds.map(() => '?').join(',')})`,
      roleIds
    );
    if (validRoles.length !== roleIds.length) {
      return res.status(400).json({ message: 'Uno o más roles no existen' });
    }

    await conn.beginTransaction();
    await conn.query(`DELETE FROM rol_personal WHERE id_personal = ?`, [id]);
    for (const id_rol of roleIds) {
      await conn.query(`INSERT INTO rol_personal (id_personal, id_rol) VALUES (?, ?)`, [id, id_rol]);
    }
    await conn.commit();

    res.json({ message: 'Roles actualizados' });
  } catch (error) {
    try {
      await conn.rollback();
    } catch (_) {}
    res.status(500).json({ message: 'Error al actualizar roles', error: error.message });
  } finally {
    conn.release();
  }
});

// DELETE /personal/:id -> desactiva (soft delete)
router.delete('/:id', auth, requireRole('administradora'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query(`UPDATE personal SET activo = 0 WHERE id_personal = ?`, [id]);
    res.json({ message: 'Personal desactivado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al desactivar personal', error: error.message });
  }
});

// PUT /personal/:id/reactivar -> reactiva
router.put('/:id/reactivar', auth, requireRole('administradora'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query(`UPDATE personal SET activo = 1 WHERE id_personal = ?`, [id]);
    res.json({ message: 'Personal reactivado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al reactivar personal', error: error.message });
  }
});

module.exports = router;
