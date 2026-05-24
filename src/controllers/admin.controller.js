'use strict';

const adminService = require('../services/admin.service');
const AppError = require('../utils/AppError');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Guard — returns true (and sends 403) if the user is not an admin.
 */
function denyNonAdmin(req, res) {
  if (req.user.role !== 'admin') {
    res.status(403).json({ success: false, message: 'Admin access required.' });
    return true;
  }
  return false;
}

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

  console.error('[admin.controller] Unexpected error:', err);
  return res.status(500).json({
    success: false,
    message: 'An unexpected error occurred. Please try again later.',
  });
}

// ---------------------------------------------------------------------------
// GET /api/admin/config
// ---------------------------------------------------------------------------
async function getConfig(req, res) {
  if (denyNonAdmin(req, res)) return;

  try {
    const config = await adminService.getConfig();
    return res.status(200).json({ success: true, data: { config } });
  } catch (err) {
    return sendError(res, err);
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/admin/config
// ---------------------------------------------------------------------------
async function updateConfig(req, res) {
  if (denyNonAdmin(req, res)) return;

  try {
    const config = await adminService.updateConfig(req.body);
    return res.status(200).json({ success: true, data: { config } });
  } catch (err) {
    return sendError(res, err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/wheels
// ---------------------------------------------------------------------------
async function getAllWheels(req, res) {
  if (denyNonAdmin(req, res)) return;

  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = parseInt(req.query.offset, 10) || 0;
    const { status } = req.query;

    const data = await adminService.getAllWheels({ status, limit, offset });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendError(res, err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/wheels/:wheelId
// ---------------------------------------------------------------------------
async function getWheelStats(req, res) {
  if (denyNonAdmin(req, res)) return;

  const { wheelId } = req.params;

  if (!UUID_REGEX.test(wheelId)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid wheel ID format. Expected a valid UUID v4.',
    });
  }

  try {
    const stats = await adminService.getWheelStats(wheelId);
    return res.status(200).json({ success: true, data: { wheel: stats } });
  } catch (err) {
    return sendError(res, err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/users
// ---------------------------------------------------------------------------
async function getUserList(req, res) {
  if (denyNonAdmin(req, res)) return;

  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = parseInt(req.query.offset, 10) || 0;
    const { role } = req.query;

    const data = await adminService.getUserList({ limit, offset, role });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendError(res, err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/admin/users/:userId/coins
// ---------------------------------------------------------------------------
async function adjustUserCoins(req, res) {
  if (denyNonAdmin(req, res)) return;

  const { userId } = req.params;

  if (!UUID_REGEX.test(userId)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid user ID format. Expected a valid UUID v4.',
    });
  }

  const { amount, type, description } = req.body;

  if (amount === undefined || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({
      success: false,
      message: 'amount must be a positive number.',
    });
  }

  try {
    const result = await adminService.adjustUserCoins(
      req.user.id,
      userId,
      amount,
      type,
      description || null,
    );
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    return sendError(res, err);
  }
}

module.exports = {
  getConfig,
  updateConfig,
  getAllWheels,
  getWheelStats,
  getUserList,
  adjustUserCoins,
};
