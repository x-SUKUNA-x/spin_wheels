'use strict';

const express = require('express');
const router = express.Router();
const promClient = require('prom-client');
const { pool } = require('../config/db');
const logger = require('../config/logger');

// Enable default metrics (CPU, RAM, Event Loop)
promClient.collectDefaultMetrics({ prefix: 'spinwheel_' });

router.get('/health', async (req, res) => {
  try {
    // Quick DB check
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'UP', timestamp: new Date() });
  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    res.status(503).json({ status: 'DOWN', error: 'Database unavailable' });
  }
});

router.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

module.exports = router;
