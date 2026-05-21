const spinWheelService = require('../services/spinWheel.service');
const AppError = require('../utils/AppError');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Helper — send a structured error response.
 * Uses AppError.statusCode when available; falls back to 500.
 */
function sendError(res, err) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      code: err.code,
      message: err.message,
    });
  }

  console.error('[spinWheel.controller] Unexpected error:', err);
  return res.status(500).json({
    success: false,
    message: 'An unexpected error occurred. Please try again later.',
  });
}

/**
 * POST /api/wheels
 * Admin only. Creates a new spin wheel from current config.
 */
async function createWheel(req, res) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required.' });
  }

  try {
    const wheel = await spinWheelService.createWheel(req.user.id);
    return res.status(201).json({ success: true, data: { wheel } });
  } catch (err) {
    return sendError(res, err);
  }
}

/**
 * POST /api/wheels/:wheelId/join
 * Authenticated user joins a spin wheel.
 */
async function joinWheel(req, res) {
  const { wheelId } = req.params;

  if (!UUID_REGEX.test(wheelId)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid wheel ID format. Expected a valid UUID v4.',
    });
  }

  try {
    const { participant, updatedWheel } = await spinWheelService.joinWheel(req.user.id, wheelId);
    return res.status(200).json({
      success: true,
      data: { participant, wheel: updatedWheel },
    });
  } catch (err) {
    return sendError(res, err);
  }
}

/**
 * GET /api/wheels/:wheelId
 * Fetch a wheel and its full participant list.
 */
async function getWheel(req, res) {
  const { wheelId } = req.params;

  if (!UUID_REGEX.test(wheelId)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid wheel ID format. Expected a valid UUID v4.',
    });
  }

  try {
    const wheel = await spinWheelService.getWheelWithParticipants(wheelId);

    if (!wheel) {
      return res.status(404).json({ success: false, message: 'Spin wheel not found.' });
    }

    return res.status(200).json({ success: true, data: { wheel } });
  } catch (err) {
    return sendError(res, err);
  }
}

/**
 * GET /api/wheels/active
 * Returns the currently active wheel, or null if none is running.
 */
async function getActiveWheel(req, res) {
  try {
    const wheel = await spinWheelService.getActiveWheel();
    return res.status(200).json({ success: true, data: { wheel: wheel || null } });
  } catch (err) {
    return sendError(res, err);
  }
}

/**
 * POST /api/wheels/:wheelId/start
 * Admin only. Manually starts the wheel (bypasses auto-start timer).
 */
async function startWheel(req, res) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required.' });
  }

  const { wheelId } = req.params;

  if (!UUID_REGEX.test(wheelId)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid wheel ID format. Expected a valid UUID v4.',
    });
  }

  try {
    const wheel = await spinWheelService.manualStartWheel(req.user.id, wheelId);
    return res.status(200).json({
      success: true,
      data: { message: 'Wheel started', wheel },
    });
  } catch (err) {
    return sendError(res, err);
  }
}

/**
 * POST /api/wheels/:wheelId/abort
 * Admin only. Aborts the wheel and refunds all participants.
 */
async function abortWheel(req, res) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required.' });
  }

  const { wheelId } = req.params;

  if (!UUID_REGEX.test(wheelId)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid wheel ID format. Expected a valid UUID v4.',
    });
  }

  try {
    await spinWheelService.adminAbortWheel(req.user.id, wheelId);
    return res.status(200).json({
      success: true,
      data: { message: 'Wheel aborted and participants refunded' },
    });
  } catch (err) {
    return sendError(res, err);
  }
}

module.exports = { createWheel, joinWheel, getWheel, getActiveWheel, startWheel, abortWheel };
