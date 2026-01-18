const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { auth, requireRole } = require('../middlewares/auth');

router.use(auth);
router.use(requireRole('vendedora', 'administradora'));

// GET /ventas -> listar ventas
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        v.id_venta, v.fecha, v.total, v.estado_pago,
        c.id_clienta, c.nombre AS clienta_nombre, c.apellido AS clienta_apellido,
        p.id_personal, p.nombre AS personal_nombre, p.apellido AS personal_apellido
      FROM venta v
      JOIN clienta c ON c.id_clienta = v.id_clienta
      JOIN personal p ON p.id_personal = v.id_personal
      ORDER BY v.id_venta DESC
    `);

    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener ventas', error: error.message });
  }
});

// GET /ventas/:id -> detalle completo (cabecera + items + pagos + resumenPago)
router.get('/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;

    // 1) Cabecera
    const [ventaRows] = await conn.query(
      `
      SELECT 
        v.id_venta, v.id_clienta, v.id_personal, v.fecha, v.total, v.estado_pago,
        c.nombre AS clienta_nombre, c.apellido AS clienta_apellido, c.telefono AS clienta_telefono,
        c.email AS clienta_email, c.direccion AS clienta_direccion,
        p.nombre AS personal_nombre, p.apellido AS personal_apellido
      FROM venta v
      JOIN clienta c ON c.id_clienta = v.id_clienta
      JOIN personal p ON p.id_personal = v.id_personal
      WHERE v.id_venta = ?
      `,
      [id]
    );

    if (ventaRows.length === 0) {
      return res.status(404).json({ message: 'Venta no encontrada' });
    }

    const venta = ventaRows[0];

    // 2) Items (detalle)
    const [items] = await conn.query(
      `
      SELECT 
        dv.id_detalle, dv.id_producto, dv.cantidad, dv.precio_unitario,
        pr.nombre AS producto_nombre, pr.marca AS producto_marca
      FROM detalle_venta dv
      JOIN producto pr ON pr.id_producto = dv.id_producto
      WHERE dv.id_venta = ?
      ORDER BY dv.id_detalle ASC
      `,
      [id]
    );

    // 3) Pagos
    const [pagos] = await conn.query(
      `
      SELECT id_pago, id_venta, monto, medio_pago, fecha
      FROM pago_venta
      WHERE id_venta = ?
      ORDER BY fecha ASC
      `,
      [id]
    );

    // 4) Resumen pagos
    const totalVenta = Number(venta.total);
    const totalPagado = pagos.reduce((acc, p) => acc + Number(p.monto), 0);
    const saldo = Math.max(totalVenta - totalPagado, 0);

    res.json({
      ...venta,
      items,
      pagos,
      resumenPago: {
        totalVenta,
        totalPagado,
        saldo
      }
    });

  } catch (error) {
    res.status(500).json({ message: 'Error al obtener venta', error: error.message });
  } finally {
    conn.release();
  }
});

// POST /ventas -> registrar venta
router.post('/', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id_clienta, items, id_personal: id_personal_body } = req.body;

    if (!id_clienta || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Campos obligatorios: id_clienta, items[]' });
    }

    // ✅ Ahora: vendedora y administradora pueden elegir id_personal.
    // Fallback: si no envían id_personal, se usa el del token.
    const id_personal = id_personal_body != null && id_personal_body !== ''
      ? Number(id_personal_body)
      : Number(req.user?.id_personal);

    if (!id_personal || Number.isNaN(id_personal)) {
      return res.status(400).json({ message: 'id_personal inválido' });
    }

    await conn.beginTransaction();

    // ✅ Validar que la persona exista, esté activa y tenga rol vendedora
    const [vendedorRows] = await conn.query(
      `
      SELECT p.id_personal
      FROM personal p
      JOIN rol_personal rp ON rp.id_personal = p.id_personal
      JOIN rol r ON r.id_rol = rp.id_rol
      WHERE p.id_personal = ?
        AND p.activo = 1
        AND r.nombre = 'vendedora'
      LIMIT 1
      `,
      [id_personal]
    );

    if (vendedorRows.length === 0) {
      await conn.rollback();
      return res.status(400).json({ message: 'La persona seleccionada no es una vendedora activa' });
    }

    // 1) Insert cabecera venta (total provisional 0)
    const [ventaResult] = await conn.query(
      `INSERT INTO venta (id_clienta, id_personal, total, estado_pago)
       VALUES (?, ?, 0, 'pendiente')`,
      [id_clienta, id_personal]
    );

    const id_venta = ventaResult.insertId;

    // 2) Insert detalle + calcular total + warnings stock minimo
    let total = 0;
    const warnings = [];

    for (const it of items) {
      const { id_producto, cantidad, precio_unitario } = it;

      if (!id_producto || !cantidad || precio_unitario == null) {
        await conn.rollback();
        return res.status(400).json({ message: 'Cada item requiere: id_producto, cantidad, precio_unitario' });
      }

      if (Number(cantidad) <= 0 || Number(precio_unitario) < 0) {
        await conn.rollback();
        return res.status(400).json({ message: 'cantidad > 0 y precio_unitario >= 0' });
      }

      // bloquear fila producto
      const [prodRows] = await conn.query(
        `SELECT id_producto, nombre, stock, stock_minimo
         FROM producto
         WHERE id_producto = ? FOR UPDATE`,
        [id_producto]
      );

      if (prodRows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ message: `Producto ${id_producto} no existe` });
      }

      const prod = prodRows[0];
      const stockActual = Number(prod.stock);
      const stockMinimo = Number(prod.stock_minimo ?? 0);
      const cant = Number(cantidad);

      if (stockActual < cant) {
        await conn.rollback();
        return res.status(400).json({ message: `Stock insuficiente para producto ${id_producto}` });
      }

      // descontar stock
      await conn.query(
        `UPDATE producto SET stock = stock - ? WHERE id_producto = ?`,
        [cant, id_producto]
      );

      const stockNuevo = stockActual - cant;

      // warning si queda en/bajo minimo
      if (!Number.isNaN(stockMinimo) && stockNuevo <= stockMinimo) {
        warnings.push({
          id_producto: Number(id_producto),
          producto_nombre: prod.nombre,
          stock_actual: stockNuevo,
          stock_minimo: stockMinimo
        });
      }

      await conn.query(
        `INSERT INTO detalle_venta (id_venta, id_producto, cantidad, precio_unitario)
         VALUES (?, ?, ?, ?)`,
        [id_venta, id_producto, cant, Number(precio_unitario)]
      );

      total += cant * Number(precio_unitario);
    }

    // 3) Actualizar total
    await conn.query(
      `UPDATE venta SET total = ? WHERE id_venta = ?`,
      [total, id_venta]
    );

    await conn.commit();

    res.status(201).json({
      message: 'Venta registrada',
      id_venta,
      total,
      warnings
    });

  } catch (error) {
    try { await conn.rollback(); } catch {}
    res.status(500).json({ message: 'Error al registrar venta', error: error.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
