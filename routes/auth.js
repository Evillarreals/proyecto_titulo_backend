const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

function authJwt(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return res.status(401).json({ message: "Token requerido" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    return next();
  } catch {
    return res.status(401).json({ message: "Token inválido o expirado" });
  }
}

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Campos obligatorios: email, password" });
    }

    const [users] = await pool.query(
      `SELECT id_personal, nombre, apellido, email, password_hash, activo, must_change_password
       FROM personal
       WHERE email = ?
       LIMIT 1`,
      [String(email).trim()]
    );

    if (users.length === 0) return res.status(401).json({ message: "Credenciales inválidas" });

    const u = users[0];
    if (u.activo !== 1) return res.status(403).json({ message: "Usuario inactivo" });
    if (!u.password_hash) return res.status(403).json({ message: "Usuario sin contraseña configurada" });

    const ok = await bcrypt.compare(String(password), u.password_hash);
    if (!ok) return res.status(401).json({ message: "Credenciales inválidas" });

    const [roleRows] = await pool.query(
      `SELECT r.nombre
       FROM rol_personal rp
       JOIN rol r ON r.id_rol = rp.id_rol
       WHERE rp.id_personal = ?`,
      [u.id_personal]
    );
    const roles = roleRows.map((r) => r.nombre);

    const token = jwt.sign(
      { id_personal: u.id_personal, email: u.email, roles },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "8h" }
    );

    res.json({
      message: "Login OK",
      token,
      must_change_password: u.must_change_password === 1,
      user: {
        id_personal: u.id_personal,
        nombre: u.nombre,
        apellido: u.apellido,
        email: u.email,
        roles,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Error en login", error: error.message });
  }
});

router.post("/change-password", authJwt, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const { id_personal } = req.user;

    if (!currentPassword || !newPassword) {
      return res
        .status(400)
        .json({ message: "Campos obligatorios: currentPassword, newPassword" });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ message: "La nueva contraseña debe tener al menos 6 caracteres" });
    }

    const [rows] = await pool.query(
      `SELECT password_hash, must_change_password, activo
       FROM personal
       WHERE id_personal = ?
       LIMIT 1`,
      [id_personal]
    );

    if (rows.length === 0) return res.status(404).json({ message: "Usuario no encontrado" });
    const u = rows[0];
    if (u.activo !== 1) return res.status(403).json({ message: "Usuario inactivo" });
    if (!u.password_hash) return res.status(400).json({ message: "Usuario sin contraseña configurada" });

    const ok = await bcrypt.compare(String(currentPassword), u.password_hash);
    if (!ok) return res.status(401).json({ message: "Contraseña actual incorrecta" });

    const newHash = await bcrypt.hash(String(newPassword), 10);

    await pool.query(
      `UPDATE personal
       SET password_hash = ?, must_change_password = 0
       WHERE id_personal = ?`,
      [newHash, id_personal]
    );

    res.json({ message: "Contraseña actualizada", must_change_password: false });
  } catch (error) {
    res.status(500).json({ message: "Error al cambiar contraseña", error: error.message });
  }
});

module.exports = router;