const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const { auth, requireRole } = require('../middlewares/auth');

/**
 * Middleware: permite crear el PRIMER usuario sin token,
 * pero SOLO si:
 * - personal está vacío
 * - x-bootstrap-key coincide con BOOTSTRAP_KEY
 *
 * Si ya hay personal, exige auth + rol administradora.
 */
async function bootstrapOrAdmin(req, res, next) {
  // Solo aplica al POST /personal
  if (req.method !== 'POST' || req.path !== '/') return next();

  try {
    const [rows] = await pool.query('SELECT COUNT(*) AS c FROM personal');
    const count = Number(rows?.[0]?.c || 0);

    // Si ya existe al menos 1 personal -> flujo normal (admin)
    if (count > 0) {
      return auth(req, res, () => requireRole('administradora')(req, res, next));
    }

    // Si NO hay personal -> bootstrap permitido solo con BOOTSTRAP_KEY
    const serverKey = process.env.BOOTSTRAP_KEY;
    const clientKey = req.headers['x-bootstrap-key'];

    if (!serverKey) {
      return res.status(500).json({
        message: 'Falta configurar BOOTSTRAP_KEY en variables de entorno'
      });
    }

    if (!clientKey || String(clientKey).trim() !== String(serverKey).trim()) {
      return res.status(401).json({
        message: 'Bootstrap key inválida (header x-bootstrap-key)'
      });
    }

    // OK -> dejar pasar sin token
    return next();
  } catch (e) {
    return res.status(500).json({
      message: 'Error validando bootstrap',
      error: e.message
    });
  }
}

/**
 * Genera una password temporal legible
 */
function generateTempPassword() {
  // 10-12 chars, mezcla segura
  return crypto.randomBytes(8).toString('base64url'); // ~11 chars
}

/**
 * POST /personal
 * - Admin (normal) o Bootstrap (si es el primero y x-bootstrap-key ok)
 * Body:
 * {
 *   "nombre": "...",
 *   "apellido": "...",
 *   "rut": "...",
 *   "direccion": "...",
 *   "telefono": "...",
 *   "email": "...",
 *   "roles": [1,2,3]   // ids de rol
 * }
 */
router.post('/', bootstrapOrAdmin, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { nombre, apellido, rut, direccion, telefono, email, roles } = req.body;

    if (!nombre || !apellido || !rut || !direccion || !telefono || !email) {
      return res.status(400).json({
        message: 'Campos obligatorios: nombre, apellido, rut, direccion, telefono, email'
      });
    }

    if (!Array.isArray(roles) || roles.length === 0) {
      return res.status(400).json({
        message: 'Debes enviar al menos un rol en "roles" (array de id_rol)'
      });
    }

    const emailNorm = String(email).trim().toLowerCase();

    // password temporal + hash
    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    await connection.beginTransaction();

    // Insert personal
    // Asumimos columnas: password_hash y must_change_password existen (según auth.js y tu cambio).
    const [result] = await connection.query(
      `INSERT INTO personal (nombre, apellido, rut, direccion, telefono, email, activo, password_hash, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1)`,
      [nombre, apellido, rut, direccion, telefono, emailNorm, passwordHash]
    );

    const id_personal = result.insertId;

    // Insert roles
    const values = roles.map(id_rol => [id_personal, id_rol]);
    await connection.query(
      'INSERT INTO rol_personal (id_personal, id_rol) VALUES ?',
      [values]
    );

    await connection.commit();

    // Devolver el personal creado + password temporal
    const [personalRows] = await pool.query(
      `SELECT id_personal, nombre, apellido, rut, direccion, telefono, email, activo, must_change_password
       FROM personal WHERE id_personal = ?`,
      [id_personal]
    );

    const [roleRows] = await pool.query(
      `SELECT r.id_rol, r.nombre
       FROM rol_personal rp
       JOIN rol r ON r.id_rol = rp.id_rol
       WHERE rp.id_personal = ?`,
      [id_personal]
    );

    return res.status(201).json({
      message: 'Personal creado',
      personal: {
        ...personalRows[0],
        roles: roleRows
      },
      temp_password: tempPassword
    });
  } catch (error) {
    await connection.rollback();
    return res.status(500).json({
      message: 'Error al crear personal',
      error: error.message
    });
  } finally {
    connection.release();
  }
});

/**
 * Desde aquí para abajo: TODO requiere administradora (sin cambiar tu lógica)
 */
router.use(auth, requireRole('administradora'));

/**
 * GET /personal
 */
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.id_personal, p.nombre, p.apellido, p.rut, p.direccion, p.telefono, p.email, p.activo, p.must_change_password,
             GROUP_CONCAT(r.nombre SEPARATOR ', ') AS roles
      FROM personal p
      LEFT JOIN rol_personal rp ON p.id_personal = rp.id_personal
      LEFT JOIN rol r ON rp.id_rol = r.id_rol
      GROUP BY p.id_personal
    `);

    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener personal', error: error.message });
  }
});

/**
 * GET /personal/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.query(
      `SELECT id_personal, nombre, apellido, rut, direccion, telefono, email, activo, must_change_password
       FROM personal WHERE id_personal = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Personal no encontrado' });
    }

    const [roles] = await pool.query(
      `SELECT r.id_rol, r.nombre
       FROM rol_personal rp
       JOIN rol r ON rp.id_rol = r.id_rol
       WHERE rp.id_personal = ?`,
      [id]
    );

    res.json({ ...rows[0], roles });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener personal', error: error.message });
  }
});

/**
 * PUT /personal/:id
 */
router.put('/:id', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const { nombre, apellido, rut, direccion, telefono, email, activo, roles } = req.body;

    if (!nombre || !apellido || !rut || !direccion || !telefono || !email) {
      return res.status(400).json({
        message: 'Campos obligatorios: nombre, apellido, rut, direccion, telefono, email'
      });
    }

    if (!Array.isArray(roles)) {
      return res.status(400).json({ message: 'El campo roles debe ser un arreglo' });
    }

    const emailNorm = String(email).trim().toLowerCase();

    await connection.beginTransaction();

    await connection.query(
      `UPDATE personal SET nombre = ?, apellido = ?, rut = ?, direccion = ?, telefono = ?, email = ?, activo = ?
       WHERE id_personal = ?`,
      [nombre, apellido, rut, direccion, telefono, emailNorm, activo, id]
    );

    await connection.query('DELETE FROM rol_personal WHERE id_personal = ?', [id]);

    if (roles.length > 0) {
      const values = roles.map(id_rol => [id, id_rol]);
      await connection.query(
        'INSERT INTO rol_personal (id_personal, id_rol) VALUES ?',
        [values]
      );
    }

    await connection.commit();
    res.json({ message: 'Personal actualizado correctamente' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ message: 'Error al actualizar personal', error: error.message });
  } finally {
    connection.release();
  }
});

/**
 * PATCH /personal/:id/toggle-activo
 */
router.patch('/:id/toggle-activo', async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.query('SELECT activo FROM personal WHERE id_personal = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Personal no encontrado' });

    const nuevoEstado = rows[0].activo === 1 ? 0 : 1;

    await pool.query('UPDATE personal SET activo = ? WHERE id_personal = ?', [nuevoEstado, id]);

    res.json({
      message: 'Estado actualizado',
      id_personal: Number(id),
      activo: nuevoEstado
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al cambiar estado', error: error.message });
  }
});

module.exports = router;
