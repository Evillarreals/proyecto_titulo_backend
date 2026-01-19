const express = require('express');
const router = express.Router();
const pool = require('../config/db');

router.get('/', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'OK',
      message: 'Backend y base de datos conectados correctamente'
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      message: 'Error de conexión con la base de datos',
      error: error.message
    });
  }
});

module.exports = router;