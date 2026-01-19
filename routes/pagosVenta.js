const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { auth, requireRole } = require('../middlewares/auth');

router.use(auth);
router.use(requireRole('vendedora', 'administradora'));

router.post('/', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id_venta, monto, medio_pago } = req.body;

    if (!id_venta || monto == null || !medio_pago) {
      return res.status(400).json({ message: 'Campos obligatorios: id_venta, monto, medio_pago' });
    }
    if (Number(monto) <= 0) return res.status(400).json({ message: 'monto debe ser > 0' });

    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO pago_venta (id_venta, monto, medio_pago) VALUES (?, ?, ?)`,
      [id_venta, monto, medio_pago]
    );

    const [ventaRows] = await conn.query(
      `SELECT total FROM venta WHERE id_venta = ? FOR UPDATE`,
      [id_venta]
    );

    if (ventaRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: 'Venta no encontrada' });
    }

    const totalVenta = Number(ventaRows[0].total);

    const [sumRows] = await conn.query(
      `SELECT COALESCE(SUM(monto),0) AS total_pagado FROM pago_venta WHERE id_venta = ?`,
      [id_venta]
    );

    const totalPagado = Number(sumRows[0].total_pagado);

    let estado_pago = 'pendiente';
    if (totalPagado >= totalVenta) estado_pago = 'pagado';
    else if (totalPagado > 0) estado_pago = 'parcial';

    await conn.query(
      `UPDATE venta SET estado_pago = ? WHERE id_venta = ?`,
      [estado_pago, id_venta]
    );

    await conn.commit();

    res.status(201).json({
      message: 'Pago registrado',
      id_venta,
      totalVenta,
      totalPagado,
      estado_pago
    });

  } catch (e) {
    try { await conn.rollback(); } catch {}
    res.status(500).json({ message: 'Error al registrar pago', error: e.message });
  } finally {
    conn.release();
  }
});

router.get('/:id_venta', async (req, res) => {
  try {
    const { id_venta } = req.params;

    const [rows] = await pool.query(
      `SELECT id_pago, id_venta, monto, medio_pago, fecha
       FROM pago_venta
       WHERE id_venta = ?
       ORDER BY fecha ASC`,
      [id_venta]
    );

    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener pagos de la venta', error: error.message });
  }
});

module.exports = router;
