// backend/routes/roles.js
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { auth, requireRole } = require('../middlewares/auth');

router.use(auth);
router.use(requireRole('administradora'));

// GET /roles -> listar roles
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM rol ORDER BY id_rol ASC');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener roles', error: error.message });
  }
});

// POST /roles -> crear rol
router.post('/', async (req, res) => {
  try {
    const { nombre } = req.body;

    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ message: 'Campo obligatorio: nombre' });
    }

    const [result] = await pool.query('INSERT INTO rol (nombre) VALUES (?)', [String(nombre).trim()]);
    res.status(201).json({ message: 'Rol creado', id_rol: result.insertId });
  } catch (error) {
    res.status(500).json({ message: 'Error al crear rol', error: error.message });
  }
});

// PUT /roles/:id -> editar rol
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre } = req.body;

    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ message: 'Campo obligatorio: nombre' });
    }

    const [result] = await pool.query(
      'UPDATE rol SET nombre = ? WHERE id_rol = ?',
      [String(nombre).trim(), id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Rol no encontrado' });
    }

    res.json({ message: 'Rol actualizado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar rol', error: error.message });
  }
});

module.exports = router;
