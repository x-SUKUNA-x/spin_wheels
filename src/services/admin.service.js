'use strict';

const { query, pool } = require('../config/db');
const AppError = require('../utils/AppError');
const { creditCoins, debitCoins } = require('./coin.service');

// ---------------------------------------------------------------------------
// getConfig
// ---------------------------------------------------------------------------

/**
 * Fetch the single spin_wheel_config row.
 * @returns {Promise<object>}
 */
async function getConfig() {
  const result = await query('SELECT * FROM spin_wheel_config WHERE id = 1', []);
  return result.rows[0] || null;
}

// ---------------------------------------------------------------------------
// updateConfig
// ---------------------------------------------------------------------------

/**
 * Partially update spin_wheel_config using a fully-parameterized query.
 *
 * @param {object} updates - Any subset of the allowed config fields
 * @returns {Promise<object>} The updated config row
 */
async function updateConfig(updates) {
  const {
    entry_fee,
    winner_pool_percent,
    admin_pool_percent,
    app_pool_percent,
    min_participants,
    auto_start_seconds,
    elimination_interval_seconds,
  } = updates;

  // --- Field-level validation ---
  if (entry_fee !== undefined && entry_fee <= 0) {
    throw new AppError('entry_fee must be greater than 0.', 400, 'VALIDATION_ERROR');
  }
  if (min_participants !== undefined && min_participants < 2) {
    throw new AppError('min_participants must be at least 2.', 400, 'VALIDATION_ERROR');
  }
  if (auto_start_seconds !== undefined && auto_start_seconds < 30) {
    throw new AppError('auto_start_seconds must be at least 30.', 400, 'VALIDATION_ERROR');
  }
  if (elimination_interval_seconds !== undefined && elimination_interval_seconds < 3) {
    throw new AppError('elimination_interval_seconds must be at least 3.', 400, 'VALIDATION_ERROR');
  }

  // --- Percent-sum validation ---
  const percentsProvided = [winner_pool_percent, admin_pool_percent, app_pool_percent].filter(
    (v) => v !== undefined,
  );

  if (percentsProvided.length > 0) {
    if (percentsProvided.length === 3) {
      // All three supplied — check directly
      const total = winner_pool_percent + admin_pool_percent + app_pool_percent;
      if (total !== 100) {
        throw new AppError(
          `winner_pool_percent + admin_pool_percent + app_pool_percent must equal 100 (got ${total}).`,
          400,
          'VALIDATION_ERROR',
        );
      }
    } else {
      // Some subset — fetch current values first, then check the resulting sum
      const current = await getConfig();
      if (!current) {
        throw new AppError('Config row not found.', 404, 'NOT_FOUND');
      }
      const resulting = {
        winner_pool_percent:
          winner_pool_percent !== undefined
            ? winner_pool_percent
            : parseFloat(current.winner_pool_percent),
        admin_pool_percent:
          admin_pool_percent !== undefined
            ? admin_pool_percent
            : parseFloat(current.admin_pool_percent),
        app_pool_percent:
          app_pool_percent !== undefined
            ? app_pool_percent
            : parseFloat(current.app_pool_percent),
      };
      const total =
        resulting.winner_pool_percent +
        resulting.admin_pool_percent +
        resulting.app_pool_percent;
      if (total !== 100) {
        throw new AppError(
          `winner_pool_percent + admin_pool_percent + app_pool_percent must equal 100 (resulting total: ${total}).`,
          400,
          'VALIDATION_ERROR',
        );
      }
    }
  }

  // --- Build parameterized UPDATE ---
  const fields = [];
  const values = [];
  let idx = 1;

  if (entry_fee !== undefined) {
    fields.push(`entry_fee = $${idx++}`);
    values.push(entry_fee);
  }
  if (winner_pool_percent !== undefined) {
    fields.push(`winner_pool_percent = $${idx++}`);
    values.push(winner_pool_percent);
  }
  if (admin_pool_percent !== undefined) {
    fields.push(`admin_pool_percent = $${idx++}`);
    values.push(admin_pool_percent);
  }
  if (app_pool_percent !== undefined) {
    fields.push(`app_pool_percent = $${idx++}`);
    values.push(app_pool_percent);
  }
  if (min_participants !== undefined) {
    fields.push(`min_participants = $${idx++}`);
    values.push(min_participants);
  }
  if (auto_start_seconds !== undefined) {
    fields.push(`auto_start_seconds = $${idx++}`);
    values.push(auto_start_seconds);
  }
  if (elimination_interval_seconds !== undefined) {
    fields.push(`elimination_interval_seconds = $${idx++}`);
    values.push(elimination_interval_seconds);
  }

  if (fields.length === 0) {
    throw new AppError('No valid fields provided for update.', 400, 'VALIDATION_ERROR');
  }

  fields.push(`updated_at = now()`);

  const sql = `UPDATE spin_wheel_config SET ${fields.join(', ')} WHERE id = 1 RETURNING *`;
  const result = await query(sql, values);
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// getAllWheels
// ---------------------------------------------------------------------------

/**
 * List spin_wheels with optional status filter and pagination.
 *
 * @param {{ status?: string, limit?: number, offset?: number }} params
 * @returns {Promise<{ wheels: object[], total: number }>}
 */
async function getAllWheels({ status, limit = 20, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const conditions = [];
  const values = [];
  let idx = 1;

  if (status !== undefined) {
    conditions.push(`status = $${idx++}`);
    values.push(status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countSql = `SELECT COUNT(*) FROM spin_wheels ${whereClause}`;
  const dataSql = `
    SELECT * FROM spin_wheels
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${idx++} OFFSET $${idx++}
  `;

  const [countResult, dataResult] = await Promise.all([
    query(countSql, values),
    query(dataSql, [...values, safeLimit, safeOffset]),
  ]);

  return {
    wheels: dataResult.rows,
    total: parseInt(countResult.rows[0].count, 10),
  };
}

// ---------------------------------------------------------------------------
// getWheelStats
// ---------------------------------------------------------------------------

/**
 * Return a wheel row with participant count, transactions, and winner username.
 *
 * @param {string} wheelId
 * @returns {Promise<object>}
 */
async function getWheelStats(wheelId) {
  const wheelResult = await query('SELECT * FROM spin_wheels WHERE id = $1', [wheelId]);

  if (wheelResult.rows.length === 0) {
    throw new AppError('Wheel not found.', 404, 'NOT_FOUND');
  }

  const wheel = wheelResult.rows[0];

  const [participantResult, transactionResult, winnerResult] = await Promise.all([
    query('SELECT COUNT(*) FROM spin_wheel_participants WHERE spin_wheel_id = $1', [wheelId]),
    query(
      'SELECT * FROM transactions WHERE spin_wheel_id = $1 ORDER BY created_at DESC',
      [wheelId],
    ),
    wheel.winner_id
      ? query('SELECT username FROM users WHERE id = $1', [wheel.winner_id])
      : Promise.resolve({ rows: [] }),
  ]);

  return {
    ...wheel,
    participantCount: parseInt(participantResult.rows[0].count, 10),
    transactions: transactionResult.rows,
    winnerUsername: winnerResult.rows[0]?.username || null,
  };
}

// ---------------------------------------------------------------------------
// getUserList
// ---------------------------------------------------------------------------

/**
 * List users (without password_hash) with optional role filter and pagination.
 *
 * @param {{ limit?: number, offset?: number, role?: string }} params
 * @returns {Promise<{ users: object[], total: number }>}
 */
async function getUserList({ limit = 20, offset = 0, role } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const conditions = [];
  const values = [];
  let idx = 1;

  if (role !== undefined) {
    conditions.push(`role = $${idx++}`);
    values.push(role);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countSql = `SELECT COUNT(*) FROM users ${whereClause}`;
  const dataSql = `
    SELECT id, username, email, role, coin_balance, created_at, updated_at
    FROM users
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${idx++} OFFSET $${idx++}
  `;

  const [countResult, dataResult] = await Promise.all([
    query(countSql, values),
    query(dataSql, [...values, safeLimit, safeOffset]),
  ]);

  return {
    users: dataResult.rows,
    total: parseInt(countResult.rows[0].count, 10),
  };
}

// ---------------------------------------------------------------------------
// adjustUserCoins
// ---------------------------------------------------------------------------

/**
 * Credit or debit coins for a user, wrapped in a DB transaction.
 *
 * @param {string} adminUserId  - ID of the admin performing the action
 * @param {string} targetUserId
 * @param {number} amount
 * @param {'credit'|'debit'} type
 * @param {string|null} description
 * @returns {Promise<{ userId: string, newBalance: number, transactionId: string }>}
 */
async function adjustUserCoins(adminUserId, targetUserId, amount, type, description) {
  if (type !== 'credit' && type !== 'debit') {
    throw new AppError("type must be 'credit' or 'debit'.", 400, 'VALIDATION_ERROR');
  }

  // Verify target user exists before acquiring client
  const userCheck = await query('SELECT id FROM users WHERE id = $1', [targetUserId]);
  if (userCheck.rows.length === 0) {
    throw new AppError('Target user not found.', 404, 'USER_NOT_FOUND');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const coinType = type === 'credit' ? 'admin_credit' : 'admin_debit';
    const desc = description || `Admin ${type} by ${adminUserId}`;

    let result;
    if (type === 'credit') {
      result = await creditCoins(client, targetUserId, amount, null, coinType, desc);
    } else {
      result = await debitCoins(client, targetUserId, amount, null, coinType, desc);
    }

    await client.query('COMMIT');

    return {
      userId: targetUserId,
      newBalance: result.newBalance,
      transactionId: result.transactionId,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
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
