'use strict';

const { Router } = require('express');
const { authenticate } = require('../middlewares/auth');
const {
  getMyTransactions,
  getWheelTransactions,
} = require('../controllers/transaction.controller');

const router = Router();

// All transaction routes require a valid JWT
router.use(authenticate);

// GET /api/transactions/me                    — current user's transactions
router.get('/me', getMyTransactions);

// GET /api/transactions/wheel/:wheelId        — transactions for a specific wheel
router.get('/wheel/:wheelId', getWheelTransactions);

module.exports = router;
