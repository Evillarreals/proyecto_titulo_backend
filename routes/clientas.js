const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { auth, requireRole } = require('../middlewares/auth');

router.use(auth, requireRole('masoterapeuta', 'administradora', 'vendedora'));

// GET /clientas -> listar todas (activas e inactivas)
// Opcional: /clientas?activo=1 o /clientas?activo=0
router.get('/', async (req, res) => {
  try {
    const { activo } = req.query;

    let sql = 'SELECT * FROM clienta';
    const params = [];

    if (activo !== undefined) {
      const a = Number(activo);
      if (Number.isNaN(a) || (a !== 0 && a !== 1)) {
        return res.status(400).json({ message: 'Query "activo" debe ser 0 o 1' });
      }
      sql += ' WHERE activo = ?';
      params.push(a);
    }

    sql += ' ORDER BY id_clienta DESC';

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener clientas', error: error.message });
  }
});

// GET /clientas/:id -> obtener una por id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT * FROM clienta WHERE id_clienta = ?', [id]);

    if (rows.length === 0) return res.status(404).json({ message: 'Clienta no encontrada' });
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener clienta', error: error.message });
  }
});

// POST /clientas -> crear clienta (activo=1 por defecto)
router.post('/', async (req, res) => {
  try {
    const { nombre, apellido, telefono, email, direccion } = req.body;

    if (!nombre || !apellido || !telefono || !direccion) {
      return res.status(400).json({
        message: 'Campos obligatorios: nombre, apellido, telefono, direccion'
      });
    }

    const [result] = await pool.query(
      `INSERT INTO clienta (nombre, apellido, telefono, email, direccion, activo)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [nombre, apellido, telefono, email || null, direccion]
    );

    res.status(201).json({ message: 'Clienta creada', id_clienta: result.insertId });
  } catch (error) {
    res.status(500).json({ message: 'Error al crear clienta', error: error.message });
  }
});

// PUT /clientas/:id -> actualizar datos (no toca "activo")
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, apellido, telefono, email, direccion } = req.body;

    if (!nombre || !apellido || !telefono || !direccion) {
      return res.status(400).json({
        message: 'Campos obligatorios: nombre, apellido, telefono, direccion'
      });
    }

    const [result] = await pool.query(
      `UPDATE clienta
       SET nombre = ?, apellido = ?, telefono = ?, email = ?, direccion = ?
       WHERE id_clienta = ?`,
      [nombre, apellido, telefono, email || null, direccion, id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ message: 'Clienta no encontrada' });

    res.json({ message: 'Clienta actualizada' });
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar clienta', error: error.message });
  }
});

// PUT /clientas/:id/activo -> activar/desactivar (recomendado para tu toggle)
router.put('/:id/activo', async (req, res) => {
  try {
    const { id } = req.params;
    const { activo } = req.body;

    const a = Number(activo);
    if (Number.isNaN(a) || (a !== 0 && a !== 1)) {
      return res.status(400).json({ message: '"activo" debe ser 0 o 1' });
    }

    const [result] = await pool.query(
      `UPDATE clienta SET activo = ? WHERE id_clienta = ?`,
      [a, id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ message: 'Clienta no encontrada' });

    const [rows] = await pool.query('SELECT * FROM clienta WHERE id_clienta = ?', [id]);
    res.json({ message: 'Estado actualizado', clienta: rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Error al cambiar estado', error: error.message });
  }
});

module.exports = router;
