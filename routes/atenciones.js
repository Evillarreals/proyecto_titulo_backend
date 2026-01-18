const express = require('express');
const router = express.Router();
const pool = require('../config/db');

const { auth, requireRole } = require('../middlewares/auth');

// Atenciones: masoterapeuta + administradora
router.use(auth, requireRole('masoterapeuta', 'administradora'));

const minToMs = (min) => Number(min) * 60 * 1000;

function toMysqlDatetimeLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() +
    '-' + pad(date.getMonth() + 1) +
    '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) +
    ':' + pad(date.getMinutes()) +
    ':' + pad(date.getSeconds())
  );
}

/**
 * Valida que el personal:
 * - exista
 * - esté activo
 * - tenga el rol requerido (ej: 'masoterapeuta')
 */
async function validatePersonalActiveWithRole(conn, id_personal, roleName) {
  const [rows] = await conn.query(
    `
    SELECT p.id_personal, p.activo
    FROM personal p
    INNER JOIN rol_personal rp ON rp.id_personal = p.id_personal
    INNER JOIN rol r ON r.id_rol = rp.id_rol
    WHERE p.id_personal = ?
      AND r.nombre = ?
    LIMIT 1
    `,
    [id_personal, roleName]
  );

  if (rows.length === 0) return { ok: false, reason: 'Personal no encontrado o sin rol requerido' };
  if (Number(rows[0].activo) === 0) return { ok: false, reason: 'Personal inactivo' };
  return { ok: true };
}

/**
 * Normaliza fecha_inicio:
 * - soporta "YYYY-MM-DD HH:mm:ss"
 * - soporta ISO
 */
function parseInicio(fecha_inicio) {
  const s = String(fecha_inicio).trim();
  const normalized = s.includes('T') ? s : s.replace(' ', 'T'); // "YYYY-MM-DD HH:mm:ss" -> "YYYY-MM-DDTHH:mm:ss"
  const dt = new Date(normalized);
  return isNaN(dt.getTime()) ? null : dt;
}

/**
 * Calcula duración total (min) desde tabla servicio
 */
async function fetchServiciosInfo(conn, servicios) {
  const ids = servicios.map((s) => s.id_servicio);

  const [srvRows] = await conn.query(
    `SELECT id_servicio, duracion_min, activo
     FROM servicio
     WHERE id_servicio IN (${ids.map(() => '?').join(',')})`,
    ids
  );

  if (srvRows.length !== ids.length) {
    return { ok: false, status: 400, message: 'Uno o más id_servicio no existen' };
  }

  const algunoInactivo = srvRows.some((s) => Number(s.activo) === 0);
  if (algunoInactivo) {
    return { ok: false, status: 409, message: 'Uno o más servicios están inactivos' };
  }

  const totalDuracion = srvRows.reduce((acc, s) => acc + Number(s.duracion_min), 0);
  return { ok: true, totalDuracion };
}

/**
 * Regla de agenda:
 * - Bloqueo real = [fecha_inicio - traslado_min, fecha_fin]
 * - fecha_fin = fecha_inicio + duracion_total (NO suma traslado)
 */
async function checkConflicts(conn, { id_personal, bloque_inicio, bloque_fin, excludeIdAtencion = null }) {
  const params = [id_personal, bloque_fin, bloque_inicio];
  let extra = '';
  if (excludeIdAtencion != null) {
    extra = 'AND a.id_atencion <> ?';
    params.splice(1, 0, excludeIdAtencion); // [id_personal, excludeId, bloque_fin, bloque_inicio]
  }

  const [rows] = await conn.query(
    `
    SELECT a.id_atencion, a.fecha_inicio, a.fecha_fin, a.traslado_min
    FROM atencion a
    WHERE a.id_personal = ?
      ${extra}
      AND a.estado_atencion <> 'cancelada'
      AND ? > DATE_SUB(a.fecha_inicio, INTERVAL a.traslado_min MINUTE)
      AND ? < a.fecha_fin
    LIMIT 1
    `,
    params
  );

  if (rows.length > 0) {
    return { ok: false, status: 409, message: 'Horario no disponible (posible doble reserva)', conflicto: rows[0] };
  }

  return { ok: true };
}

// GET /atenciones (lista)
router.get('/', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `
      SELECT
        a.id_atencion,
        a.id_clienta,
        a.id_personal,
        a.fecha_inicio,
        a.fecha_fin,
        a.traslado_min,
        a.total,
        a.estado_atencion,
        a.estado_pago,

        c.nombre  AS clienta_nombre,
        c.apellido AS clienta_apellido,

        p.nombre AS personal_nombre,
        p.apellido AS personal_apellido
      FROM atencion a
      INNER JOIN clienta c ON c.id_clienta = a.id_clienta
      INNER JOIN personal p ON p.id_personal = a.id_personal
      ORDER BY a.fecha_inicio ASC
      `
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: 'Error al listar atenciones', error: e.message });
  } finally {
    conn.release();
  }
});

// GET /atenciones/:id (detalle)
router.get('/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;

    const [atRows] = await conn.query(
      `
      SELECT
        a.*,
        c.nombre  AS clienta_nombre,
        c.apellido AS clienta_apellido,
        c.telefono AS clienta_telefono,
        c.email AS clienta_email,
        c.direccion AS clienta_direccion,
        p.nombre AS personal_nombre,
        p.apellido AS personal_apellido
      FROM atencion a
      INNER JOIN clienta c ON c.id_clienta = a.id_clienta
      INNER JOIN personal p ON p.id_personal = a.id_personal
      WHERE a.id_atencion = ?
      LIMIT 1
      `,
      [id]
    );

    if (atRows.length === 0) return res.status(404).json({ message: 'Atención no encontrada' });

    const [servicios] = await conn.query(
      `
      SELECT
        ats.id_atencion_servicio,
        ats.id_servicio,
        s.nombre AS servicio_nombre,
        s.duracion_min,
        ats.precio_aplicado
      FROM atencion_servicio ats
      INNER JOIN servicio s ON s.id_servicio = ats.id_servicio
      WHERE ats.id_atencion = ?
      `,
      [id]
    );

    // ✅ FIX: PK real en pago_atencion es id_pago (no id_pago_atencion)
    const [pagos] = await conn.query(
      `
      SELECT id_pago, fecha, monto, medio_pago
      FROM pago_atencion
      WHERE id_atencion = ?
      ORDER BY fecha ASC
      `,
      [id]
    );

    const totalAtencion = Number(atRows[0].total || 0);
    const totalPagado = pagos.reduce((acc, p) => acc + Number(p.monto || 0), 0);
    const saldo = Math.max(0, totalAtencion - totalPagado);

    res.json({
      atencion: atRows[0],
      servicios,
      pagos,
      resumenPago: { totalAtencion, totalPagado, saldo }
    });
  } catch (e) {
    res.status(500).json({ message: 'Error al obtener atención', error: e.message });
  } finally {
    conn.release();
  }
});

// POST /atenciones (crear)
router.post('/', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    let { id_clienta, id_personal, fecha_inicio, traslado_min, servicios } = req.body;

    if (!id_clienta || !fecha_inicio || !Array.isArray(servicios) || servicios.length === 0) {
      return res.status(400).json({ message: 'Campos obligatorios: id_clienta, fecha_inicio, servicios[]' });
    }

    // si no mandan personal, usar el del usuario logueado
    if (!id_personal) id_personal = req.user?.id_personal;

    if (!id_personal) {
      return res.status(400).json({ message: 'Campos obligatorios: id_personal' });
    }

    // validar personal activo + rol masoterapeuta
    const okPers = await validatePersonalActiveWithRole(conn, id_personal, 'masoterapeuta');
    if (!okPers.ok) return res.status(400).json({ message: okPers.reason });

    const traslado = traslado_min == null ? 0 : Number(traslado_min);
    if (traslado < 0) return res.status(400).json({ message: 'traslado_min no puede ser negativo' });

    const inicioDate = parseInicio(fecha_inicio);
    if (!inicioDate) return res.status(400).json({ message: 'fecha_inicio inválida. Usa "YYYY-MM-DD HH:mm:ss"' });

    // servicios + duración total
    const infoSrv = await fetchServiciosInfo(conn, servicios);
    if (!infoSrv.ok) return res.status(infoSrv.status).json({ message: infoSrv.message });

    const totalDuracion = infoSrv.totalDuracion;

    // fecha_fin = inicio + duracion (NO suma traslado)
    const finDate = new Date(inicioDate.getTime() + minToMs(totalDuracion));
    const fecha_fin = toMysqlDatetimeLocal(finDate);

    // Bloqueo real
    const bloque_inicio = toMysqlDatetimeLocal(new Date(inicioDate.getTime() - minToMs(traslado)));
    const bloque_fin = fecha_fin;

    // validar conflicto por masoterapeuta
    const conf = await checkConflicts(conn, { id_personal, bloque_inicio, bloque_fin });
    if (!conf.ok) return res.status(conf.status).json({ message: conf.message, conflicto: conf.conflicto });

    // total (se basa en precio_aplicado)
    const total = servicios.reduce((acc, s) => acc + Number(s.precio_aplicado || 0), 0);
    if (total <= 0) return res.status(400).json({ message: 'El total debe ser mayor a 0' });

    await conn.beginTransaction();

    const [insAt] = await conn.query(
      `
      INSERT INTO atencion (id_clienta, id_personal, fecha_inicio, fecha_fin, traslado_min, total)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [id_clienta, id_personal, toMysqlDatetimeLocal(inicioDate), fecha_fin, traslado, total]
    );

    const id_atencion = insAt.insertId;

    for (const s of servicios) {
      await conn.query(
        `
        INSERT INTO atencion_servicio (id_atencion, id_servicio, precio_aplicado)
        VALUES (?, ?, ?)
        `,
        [id_atencion, s.id_servicio, s.precio_aplicado]
      );
    }

    await conn.commit();

    res.status(201).json({
      message: 'Atención registrada',
      id_atencion,
      fecha_inicio: toMysqlDatetimeLocal(inicioDate),
      fecha_fin,
      bloque_inicio,
      bloque_fin,
      traslado_min: traslado,
      duracion_total_min: totalDuracion,
      total
    });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    res.status(500).json({ message: 'Error al registrar atención', error: e.message });
  } finally {
    conn.release();
  }
});

// PUT /atenciones/:id (editar completa)
router.put('/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    let { id_clienta, id_personal, fecha_inicio, traslado_min, servicios, estado_atencion } = req.body;

    if (!id_clienta || !fecha_inicio || !Array.isArray(servicios) || servicios.length === 0) {
      return res.status(400).json({ message: 'Campos obligatorios: id_clienta, fecha_inicio, servicios[]' });
    }

    const [existe] = await conn.query(`SELECT id_atencion FROM atencion WHERE id_atencion = ?`, [id]);
    if (existe.length === 0) return res.status(404).json({ message: 'Atención no encontrada' });

    if (!id_personal) id_personal = req.user?.id_personal;
    if (!id_personal) return res.status(400).json({ message: 'Campos obligatorios: id_personal' });

    const okPers = await validatePersonalActiveWithRole(conn, id_personal, 'masoterapeuta');
    if (!okPers.ok) return res.status(400).json({ message: okPers.reason });

    const traslado = traslado_min == null ? 0 : Number(traslado_min);
    if (traslado < 0) return res.status(400).json({ message: 'traslado_min no puede ser negativo' });

    const inicioDate = parseInicio(fecha_inicio);
    if (!inicioDate) return res.status(400).json({ message: 'fecha_inicio inválida. Usa "YYYY-MM-DD HH:mm:ss"' });

    const infoSrv = await fetchServiciosInfo(conn, servicios);
    if (!infoSrv.ok) return res.status(infoSrv.status).json({ message: infoSrv.message });

    const totalDuracion = infoSrv.totalDuracion;

    const finDate = new Date(inicioDate.getTime() + minToMs(totalDuracion));
    const fecha_fin = toMysqlDatetimeLocal(finDate);

    const bloque_inicio = toMysqlDatetimeLocal(new Date(inicioDate.getTime() - minToMs(traslado)));
    const bloque_fin = fecha_fin;

    const conf = await checkConflicts(conn, { id_personal, bloque_inicio, bloque_fin, excludeIdAtencion: id });
    if (!conf.ok) return res.status(conf.status).json({ message: conf.message, conflicto: conf.conflicto });

    const total = servicios.reduce((acc, s) => acc + Number(s.precio_aplicado || 0), 0);
    if (total <= 0) return res.status(400).json({ message: 'El total debe ser mayor a 0' });

    await conn.beginTransaction();

    await conn.query(
      `
      UPDATE atencion
      SET id_clienta = ?, id_personal = ?, fecha_inicio = ?, fecha_fin = ?, traslado_min = ?, total = ?,
          estado_atencion = COALESCE(?, estado_atencion)
      WHERE id_atencion = ?
      `,
      [id_clienta, id_personal, toMysqlDatetimeLocal(inicioDate), fecha_fin, traslado, total, estado_atencion || null, id]
    );

    await conn.query(`DELETE FROM atencion_servicio WHERE id_atencion = ?`, [id]);

    for (const s of servicios) {
      await conn.query(
        `
        INSERT INTO atencion_servicio (id_atencion, id_servicio, precio_aplicado)
        VALUES (?, ?, ?)
        `,
        [id, s.id_servicio, s.precio_aplicado]
      );
    }

    await conn.commit();

    res.json({
      message: 'Atención actualizada',
      id_atencion: Number(id),
      fecha_inicio: toMysqlDatetimeLocal(inicioDate),
      fecha_fin,
      bloque_inicio,
      bloque_fin,
      traslado_min: traslado,
      duracion_total_min: totalDuracion,
      total
    });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    res.status(500).json({ message: 'Error al actualizar atención', error: e.message });
  } finally {
    conn.release();
  }
});

// PATCH /atenciones/:id/estado (cambiar estado_atencion)
router.patch('/:id/estado', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const { estado_atencion } = req.body;

    const allowed = ['pendiente', 'realizada', 'cancelada'];
    if (!allowed.includes(String(estado_atencion))) {
      return res.status(400).json({ message: `estado_atencion inválido. Usa: ${allowed.join(', ')}` });
    }

    const [r] = await conn.query(
      `UPDATE atencion SET estado_atencion = ? WHERE id_atencion = ?`,
      [estado_atencion, id]
    );

    if (r.affectedRows === 0) return res.status(404).json({ message: 'Atención no encontrada' });

    res.json({ message: 'Estado actualizado', id_atencion: Number(id), estado_atencion });
  } catch (e) {
    res.status(500).json({ message: 'Error al actualizar estado', error: e.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
