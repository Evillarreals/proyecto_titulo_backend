const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { auth, requireRole } = require('../middlewares/auth');

router.use(auth);
router.use(requireRole('masoterapeuta', 'administradora'));

router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_servicio, nombre, duracion_min, precio_base, activo
       FROM servicio
       ORDER BY id_servicio DESC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener servicios', error: error.message });
  }
});

router.get('/todos', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_servicio, nombre, duracion_min, precio_base, activo
       FROM servicio
       ORDER BY id_servicio DESC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener todos los servicios', error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      `SELECT id_servicio, nombre, duracion_min, precio_base, activo
       FROM servicio
       WHERE id_servicio = ?`,
      [id]
    );

    if (rows.length === 0) return res.status(404).json({ message: 'Servicio no encontrado' });
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener servicio', error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { nombre, duracion_min, precio_base } = req.body;

    if (!nombre || !duracion_min || !precio_base) {
      return res.status(400).json({
        message: 'Faltan campos obligatorios: nombre, duracion_min, precio_base'
      });
    }

    const [result] = await pool.query(
      `INSERT INTO servicio (nombre, duracion_min, precio_base, activo)
       VALUES (?, ?, ?, 1)`,
      [nombre, duracion_min, precio_base]
    );

    res.status(201).json({
      message: 'Servicio creado',
      id_servicio: result.insertId
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al crear servicio', error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, duracion_min, precio_base } = req.body;

    const fields = [];
    const values = [];

    if (nombre !== undefined) { fields.push('nombre = ?'); values.push(nombre); }
    if (duracion_min !== undefined) { fields.push('duracion_min = ?'); values.push(duracion_min); }
    if (precio_base !== undefined) { fields.push('precio_base = ?'); values.push(precio_base); }

    if (fields.length === 0) {
      return res.status(400).json({ message: 'No se enviaron campos para actualizar' });
    }

    values.push(id);

    const [result] = await pool.query(
      `UPDATE servicio SET ${fields.join(', ')} WHERE id_servicio = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Servicio no encontrado' });
    }

    res.json({ message: 'Servicio actualizado correctamente' });
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar servicio', error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.query(
      `UPDATE servicio SET activo = 0
       WHERE id_servicio = ? AND activo = 1`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Servicio no encontrado o ya está inactivo' });
    }

    res.json({ message: 'Servicio desactivado correctamente' });
  } catch (error) {
    res.status(500).json({ message: 'Error al desactivar servicio', error: error.message });
  }
});

router.put('/:id/activar', async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.query(
      `UPDATE servicio SET activo = 1
       WHERE id_servicio = ? AND activo = 0`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Servicio no encontrado o ya se encuentra activo' });
    }

    res.json({ message: 'Servicio reactivado correctamente' });
  } catch (error) {
    res.status(500).json({ message: 'Error al reactivar servicio', error: error.message });
  }
});

module.exports = router;