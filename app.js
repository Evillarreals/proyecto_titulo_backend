const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ ok: true, service: "backend", status: "running" });
});

// Rutas
const healthRoutes = require('./routes/health');
app.use('/health', healthRoutes);

const clientasRoutes = require('./routes/clientas');
app.use('/clientas', clientasRoutes);

const productosRoutes = require('./routes/productos');
app.use('/productos', productosRoutes);

const serviciosRoutes = require('./routes/servicios');
app.use('/servicios', serviciosRoutes);

const atencionesRoutes = require('./routes/atenciones');
app.use('/atenciones', atencionesRoutes);

const ventasRoutes = require('./routes/ventas');
app.use('/ventas', ventasRoutes);

const pagosVentaRoutes = require('./routes/pagosVenta');
app.use('/pagos-venta', pagosVentaRoutes);

const pagosAtencionRoutes = require('./routes/pagosAtencion');
app.use('/pagos-atencion', pagosAtencionRoutes);

const rolesRoutes = require('./routes/roles');
app.use('/roles', rolesRoutes);

const personalRoutes = require('./routes/personal');
app.use('/personal', personalRoutes);

const authRoutes = require('./routes/auth');
app.use('/auth', authRoutes);

app.use((req, res) => {
  res.status(404).json({ message: "Ruta no encontrada" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Error interno", error: err?.message || String(err) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor backend ejecutándose en http://localhost:${PORT}`);
});
