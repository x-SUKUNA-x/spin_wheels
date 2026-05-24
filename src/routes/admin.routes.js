'use strict';

const { Router } = require('express');
const { authenticate } = require('../middlewares/auth');
const {
  getConfig,
  updateConfig,
  getAllWheels,
  getWheelStats,
  getUserList,
  adjustUserCoins,
} = require('../controllers/admin.controller');

const router = Router();

// All admin routes require a valid JWT
router.use(authenticate);

// GET    /api/admin/config                — fetch current spin wheel config
router.get('/config', getConfig);

// PATCH  /api/admin/config                — partially update config
router.patch('/config', updateConfig);

// GET    /api/admin/wheels                — list all wheels (optional ?status=&limit=&offset=)
router.get('/wheels', getAllWheels);

// GET    /api/admin/wheels/:wheelId       — detailed stats for a single wheel
router.get('/wheels/:wheelId', getWheelStats);

// GET    /api/admin/users                 — list users (optional ?role=&limit=&offset=)
router.get('/users', getUserList);

// POST   /api/admin/users/:userId/coins   — credit or debit a user's coins
router.post('/users/:userId/coins', adjustUserCoins);

module.exports = router;
