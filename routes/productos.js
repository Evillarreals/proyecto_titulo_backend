const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { auth, requireRole } = require('../middlewares/auth');

router.use(auth);
router.use(requireRole('vendedora', 'administradora'));

router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_producto, nombre, marca, precio, stock, stock_minimo, activo
       FROM producto
       ORDER BY id_producto DESC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener productos', error: error.message });
  }
});

router.get('/stock-bajo', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_producto, nombre, marca, precio, stock, stock_minimo, activo
       FROM producto
       WHERE activo = 1 AND stock <= stock_minimo
       ORDER BY stock ASC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al consultar stock bajo', error: error.message });
  }
});

router.put('/:id/sumar-stock', async (req, res) => {
  try {
    const { id } = req.params;
    const { cantidad } = req.body;

    const cant = Number(cantidad);

    if (!Number.isFinite(cant) || !Number.isInteger(cant) || cant <= 0) {
      return res.status(400).json({ message: 'cantidad debe ser un entero mayor a 0' });
    }

    const [result] = await pool.query(
      `UPDATE producto
       SET stock = stock + ?
       WHERE id_producto = ?`,
      [cant, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Producto no encontrado' });
    }

    const [rows] = await pool.query(
      `SELECT id_producto, stock FROM producto WHERE id_producto = ?`,
      [id]
    );

    res.json({
      message: 'Stock actualizado',
      id_producto: Number(id),
      stock: rows?.[0]?.stock ?? null
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al sumar stock', error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.query(
      `SELECT id_producto, nombre, marca, precio, stock, stock_minimo, activo
       FROM producto
       WHERE id_producto = ?`,
      [id]
    );

    if (rows.length === 0) return res.status(404).json({ message: 'Producto no encontrado' });
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener producto', error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { nombre, marca, precio, stock, stock_minimo } = req.body;

    if (!nombre || precio == null || stock == null || stock_minimo == null) {
      return res.status(400).json({
        message: 'Faltan campos obligatorios: nombre, precio, stock, stock_minimo'
      });
    }

    if (Number(precio) < 0 || Number(stock) < 0 || Number(stock_minimo) < 0) {
      return res.status(400).json({ message: 'precio/stock/stock_minimo no pueden ser negativos' });
    }

    const [result] = await pool.query(
      `INSERT INTO producto (nombre, marca, precio, stock, stock_minimo, activo)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [nombre, marca || null, precio, stock, stock_minimo]
    );

    res.status(201).json({ message: 'Producto creado', id_producto: result.insertId });
  } catch (error) {
    res.status(500).json({ message: 'Error al crear producto', error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, marca, precio, stock, stock_minimo } = req.body;

    const fields = [];
    const values = [];

    if (nombre !== undefined) { fields.push('nombre = ?'); values.push(nombre); }
    if (marca !== undefined) { fields.push('marca = ?'); values.push(marca); }
    if (precio !== undefined) { fields.push('precio = ?'); values.push(precio); }
    if (stock !== undefined) { fields.push('stock = ?'); values.push(stock); }
    if (stock_minimo !== undefined) { fields.push('stock_minimo = ?'); values.push(stock_minimo); }

    if (fields.length === 0) {
      return res.status(400).json({ message: 'No se enviaron campos para actualizar' });
    }

    values.push(id);

    const [result] = await pool.query(
      `UPDATE producto SET ${fields.join(', ')} WHERE id_producto = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Producto no encontrado' });
    }

    res.json({ message: 'Producto actualizado correctamente' });
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar producto', error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.query(
      `UPDATE producto SET activo = 0
       WHERE id_producto = ? AND activo = 1`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Producto no encontrado o ya está inactivo' });
    }

    res.json({ message: 'Producto desactivado correctamente' });
  } catch (error) {
    res.status(500).json({ message: 'Error al desactivar producto', error: error.message });
  }
});

router.put('/:id/activar', async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.query(
      `UPDATE producto SET activo = 1
       WHERE id_producto = ? AND activo = 0`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Producto no encontrado o ya se encuentra activo' });
    }

    res.json({ message: 'Producto reactivado correctamente' });
  } catch (error) {
    res.status(500).json({ message: 'Error al reactivar producto', error: error.message });
  }
});

module.exports = router;