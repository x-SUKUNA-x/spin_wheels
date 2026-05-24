'use strict';

const transactionService = require('../services/transaction.service');
const AppError = require('../utils/AppError');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Helper — send a structured error response.
 */
function sendError(res, err) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      code: err.code,
      message: err.message,
    });
  }

  console.error('[transaction.controller] Unexpected error:', err);
  return res.status(500).json({
    success: false,
    message: 'An unexpected error occurred. Please try again later.',
  });
}

// ---------------------------------------------------------------------------
// GET /api/transactions/me
// ---------------------------------------------------------------------------

/**
 * Fetch the authenticated user's own transactions.
 * Query params: ?limit=&offset=&type=
 */
async function getMyTransactions(req, res) {
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = parseInt(req.query.offset, 10) || 0;
    const { type } = req.query;

    const data = await transactionService.getUserTransactions(req.user.id, {
      limit,
      offset,
      type,
    });

    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendError(res, err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/transactions/wheel/:wheelId
// ---------------------------------------------------------------------------

/**
 * Fetch all transactions for a specific spin wheel.
 * Query params: ?limit=&offset=
 */
async function getWheelTransactions(req, res) {
  const { wheelId } = req.params;

  if (!UUID_REGEX.test(wheelId)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid wheel ID format. Expected a valid UUID v4.',
    });
  }

  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = parseInt(req.query.offset, 10) || 0;

    const data = await transactionService.getWheelTransactions(wheelId, {
      limit,
      offset,
    });

    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendError(res, err);
  }
}

module.exports = { getMyTransactions, getWheelTransactions };
