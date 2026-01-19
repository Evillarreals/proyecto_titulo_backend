const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { auth, requireRole } = require('../middlewares/auth');

router.use(auth);
router.use(requireRole('masoterapeuta', 'administradora'));

router.post('/', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id_atencion, monto, medio_pago } = req.body;

    if (!id_atencion || monto == null || !medio_pago) {
      return res.status(400).json({ message: 'Campos obligatorios: id_atencion, monto, medio_pago' });
    }
    if (Number(monto) <= 0) return res.status(400).json({ message: 'monto debe ser > 0' });

    await conn.beginTransaction();

    const [atRows] = await conn.query(
      `SELECT total FROM atencion WHERE id_atencion = ? FOR UPDATE`,
      [id_atencion]
    );

    if (atRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: 'Atención no encontrada' });
    }

    const totalAtencion = Number(atRows[0].total);

    await conn.query(
      `INSERT INTO pago_atencion (id_atencion, monto, medio_pago) VALUES (?, ?, ?)`,
      [id_atencion, monto, medio_pago]
    );

    const [sumRows] = await conn.query(
      `SELECT COALESCE(SUM(monto),0) AS total_pagado FROM pago_atencion WHERE id_atencion = ?`,
      [id_atencion]
    );

    const totalPagado = Number(sumRows[0].total_pagado);

    let estado_pago = 'pendiente';
    if (totalPagado >= totalAtencion) estado_pago = 'pagado';
    else if (totalPagado > 0) estado_pago = 'parcial';

    await conn.query(
      `UPDATE atencion SET estado_pago = ? WHERE id_atencion = ?`,
      [estado_pago, id_atencion]
    );

    await conn.commit();

    res.status(201).json({
      message: 'Pago registrado',
      id_atencion,
      totalAtencion,
      totalPagado,
      estado_pago
    });

  } catch (e) {
    try { await conn.rollback(); } catch {}
    res.status(500).json({ message: 'Error al registrar pago de atención', error: e.message });
  } finally {
    conn.release();
  }
});

router.get('/:id_atencion', async (req, res) => {
  try {
    const { id_atencion } = req.params;

    const [rows] = await pool.query(
      `SELECT id_pago, id_atencion, monto, medio_pago, fecha
       FROM pago_atencion
       WHERE id_atencion = ?
       ORDER BY fecha ASC`,
      [id_atencion]
    );

    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener pagos de la atención', error: error.message });
  }
});

module.exports = router;
