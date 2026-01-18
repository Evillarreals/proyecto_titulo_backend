const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();

const pool = require('../config/db');
const { auth, requireRole } = require('../middlewares/auth');

// =========================
// Helpers
// =========================
async function getPersonalCount() {
  const [rows] = await pool.query('SELECT COUNT(*) AS total FROM personal');
  return rows?.[0]?.total ?? 0;
}

function getBootstrapKeyFromRequest(req) {
  // Postman header: x-bootstrap-key
  return req.get('x-bootstrap-key');
}

function isBootstrapKeyConfigured() {
  return !!process.env.BOOTSTRAP_KEY && String(process.env.BOOTSTRAP_KEY).trim() !== '';
}

function isBootstrapKeyValid(req) {
  const headerKey = getBootstrapKeyFromRequest(req);
  const envKey = process.env.BOOTSTRAP_KEY;
  return headerKey && envKey && String(headerKey).trim() === String(envKey).trim();
}

async function rolesExist(roleIds) {
  if (!Array.isArray(roleIds) || roleIds.length === 0) return false;

  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM rol
     WHERE id_rol IN (?)`,
    [roleIds]
  );

  return (rows?.[0]?.total ?? 0) === roleIds.length;
}

async function replaceRolesForPersonal(conn, id_personal, roleIds) {
  await conn.query('DELETE FROM rol_personal WHERE id_personal = ?', [id_personal]);

  if (roleIds.length > 0) {
    const values = roleIds.map((rid) => [id_personal, rid]);
    await conn.query('INSERT INTO rol_personal (id_personal, id_rol) VALUES ?', [values]);
  }
}

// Middleware especial para POST /personal
// - Si NO hay personal en la BD: permite crear con x-bootstrap-key
// - Si YA hay personal: exige auth + administradora
async function bootstrapOrAdmin(req, res, next) {
  try {
    const total = await getPersonalCount();

    if (total === 0) {
      if (!isBootstrapKeyConfigured()) {
        return res.status(500).json({
          message: 'BOOTSTRAP_KEY no está configurada en el servicio (Railway).',
          error: 'Missing BOOTSTRAP_KEY'
        });
      }

      if (!isBootstrapKeyValid(req)) {
        return res.status(401).json({
          message: 'Error validando bootstrap',
          error: 'Invalid bootstrap key'
        });
      }

      // OK, primer usuario permitido por bootstrap
      return next();
    }

    // Si ya existe personal => requiere token y rol admin
    return auth(req, res, () => requireRole('administradora')(req, res, next));
  } catch (err) {
    return res.status(500).json({
      message: 'Error validando bootstrap',
      error: err?.message || String(err)
    });
  }
}

// =========================
// Rutas
// =========================

// LISTAR personal (solo admin)
router.get('/', auth, requireRole('administradora'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_personal, nombre, apellido, rut, direccion, telefono, email, activo, must_change_password
       FROM personal
       ORDER BY id_personal DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener personal', error: err?.message || String(err) });
  }
});

// OBTENER por id (solo admin)
router.get('/:id', auth, requireRole('administradora'), async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.query(
      `SELECT id_personal, nombre, apellido, rut, direccion, telefono, email, activo, must_change_password
       FROM personal
       WHERE id_personal = ?`,
      [id]
    );

    if (rows.length === 0) return res.status(404).json({ message: 'Personal no encontrado' });

    const [roles] = await pool.query(
      `SELECT r.id_rol, r.nombre
       FROM rol_personal rp
       JOIN rol r ON r.id_rol = rp.id_rol
       WHERE rp.id_personal = ?`,
      [id]
    );

    res.json({ ...rows[0], roles });
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener personal', error: err?.message || String(err) });
  }
});

// CREAR personal
// - Primer personal: header x-bootstrap-key válido
// - Luego: admin con token
router.post('/', bootstrapOrAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { nombre, apellido, rut, direccion, telefono, email, roles } = req.body;

    if (!nombre || !apellido || !rut || !direccion || !telefono || !email) {
      return res.status(400).json({ message: 'Faltan campos obligatorios.' });
    }

    const roleIds = Array.isArray(roles) ? roles.map(Number) : [];
    if (roleIds.length === 0) {
      return res.status(400).json({ message: 'Debes enviar roles (ids) en un arreglo.' });
    }

    const okRoles = await rolesExist(roleIds);
    if (!okRoles) return res.status(400).json({ message: 'Uno o más roles no existen.' });

    // Password temporal
    const tempPassword = `Temp${rut.replace(/[^0-9kK]/g, '').slice(-4) || '0000'}!`;
    const hashed = await bcrypt.hash(tempPassword, 10);

    await conn.beginTransaction();

    // Evitar duplicados por email/rut
    const [dup] = await conn.query(
      `SELECT id_personal FROM personal WHERE email = ? OR rut = ? LIMIT 1`,
      [email, rut]
    );
    if (dup.length > 0) {
      await conn.rollback();
      return res.status(409).json({ message: 'Ya existe un personal con ese email o rut.' });
    }

    const [result] = await conn.query(
      `INSERT INTO personal (nombre, apellido, rut, direccion, telefono, email, activo, password, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1)`,
      [nombre, apellido, rut, direccion, telefono, email, hashed]
    );

    const id_personal = result.insertId;

    await replaceRolesForPersonal(conn, id_personal, roleIds);

    await conn.commit();

    res.status(201).json({
      message: 'Personal creado correctamente',
      id_personal,
      tempPassword,
      must_change_password: 1
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    res.status(500).json({ message: 'Error al crear personal', error: err?.message || String(err) });
  } finally {
    conn.release();
  }
});

// ACTUALIZAR datos personales (solo admin)
router.put('/:id', auth, requireRole('administradora'), async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, apellido, rut, direccion, telefono, email } = req.body;

    if (!nombre || !apellido || !rut || !direccion || !telefono || !email) {
      return res.status(400).json({ message: 'Faltan campos obligatorios.' });
    }

    const [result] = await pool.query(
      `UPDATE personal
       SET nombre=?, apellido=?, rut=?, direccion=?, telefono=?, email=?
       WHERE id_personal=?`,
      [nombre, apellido, rut, direccion, telefono, email, id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ message: 'Personal no encontrado' });

    res.json({ message: 'Personal actualizado correctamente' });
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar personal', error: err?.message || String(err) });
  }
});

// ACTUALIZAR roles (solo admin)
router.put('/:id/roles', auth, requireRole('administradora'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const { roles } = req.body;

    const roleIds = Array.isArray(roles) ? roles.map(Number) : [];
    if (roleIds.length === 0) return res.status(400).json({ message: 'Debes enviar roles (ids) en un arreglo.' });

    const okRoles = await rolesExist(roleIds);
    if (!okRoles) return res.status(400).json({ message: 'Uno o más roles no existen.' });

    await conn.beginTransaction();

    const [exists] = await conn.query(`SELECT id_personal FROM personal WHERE id_personal=?`, [id]);
    if (exists.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: 'Personal no encontrado' });
    }

    await replaceRolesForPersonal(conn, id, roleIds);

    await conn.commit();
    res.json({ message: 'Roles actualizados correctamente' });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    res.status(500).json({ message: 'Error al actualizar roles', error: err?.message || String(err) });
  } finally {
    conn.release();
  }
});

// INACTIVAR (soft delete) (solo admin)
router.delete('/:id', auth, requireRole('administradora'), async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.query(
      `UPDATE personal SET activo = 0 WHERE id_personal = ?`,
      [id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ message: 'Personal no encontrado' });

    res.json({ message: 'Personal inactivado correctamente' });
  } catch (err) {
    res.status(500).json({ message: 'Error al inactivar personal', error: err?.message || String(err) });
  }
});

// REACTIVAR (solo admin)
router.put('/:id/activar', auth, requireRole('administradora'), async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.query(
      `UPDATE personal SET activo = 1 WHERE id_personal = ?`,
      [id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ message: 'Personal no encontrado' });

    res.json({ message: 'Personal reactivado correctamente' });
  } catch (err) {
    res.status(500).json({ message: 'Error al reactivar personal', error: err?.message || String(err) });
  }
});

module.exports = router;
