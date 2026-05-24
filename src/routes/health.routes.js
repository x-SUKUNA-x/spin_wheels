'use strict';

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

router.get('/health', async (req, res) => {
  try {
    // Quick DB check
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'UP', timestamp: new Date() });
  } catch (error) {
    console.error('Health check failed', { error: error.message });
    res.status(503).json({ status: 'DOWN', error: 'Database unavailable' });
  }
});

module.exports = router;
