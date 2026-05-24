'use strict';

const { query } = require('../config/db');

// ---------------------------------------------------------------------------
// getUserTransactions
// ---------------------------------------------------------------------------

/**
 * Fetch paginated transactions for a user with an optional type filter.
 *
 * @param {string} userId
 * @param {{ limit?: number, offset?: number, type?: string }} params
 * @returns {Promise<{ transactions: object[], total: number }>}
 */
async function getUserTransactions(userId, { limit = 20, offset = 0, type } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const conditions = ['user_id = $1'];
  const values = [userId];
  let idx = 2;

  if (type !== undefined) {
    conditions.push(`type = $${idx++}`);
    values.push(type);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const countSql = `SELECT COUNT(*) FROM transactions ${whereClause}`;
  const dataSql = `
    SELECT * FROM transactions
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${idx++} OFFSET $${idx++}
  `;

  const [countResult, dataResult] = await Promise.all([
    query(countSql, values),
    query(dataSql, [...values, safeLimit, safeOffset]),
  ]);

  return {
    transactions: dataResult.rows,
    total: parseInt(countResult.rows[0].count, 10),
  };
}

// ---------------------------------------------------------------------------
// getWheelTransactions
// ---------------------------------------------------------------------------

/**
 * Fetch paginated transactions linked to a specific spin wheel.
 *
 * @param {string} wheelId
 * @param {{ limit?: number, offset?: number }} params
 * @returns {Promise<{ transactions: object[], total: number }>}
 */
async function getWheelTransactions(wheelId, { limit = 20, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const [countResult, dataResult] = await Promise.all([
    query('SELECT COUNT(*) FROM transactions WHERE spin_wheel_id = $1', [wheelId]),
    query(
      `SELECT * FROM transactions
       WHERE spin_wheel_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [wheelId, safeLimit, safeOffset],
    ),
  ]);

  return {
    transactions: dataResult.rows,
    total: parseInt(countResult.rows[0].count, 10),
  };
}

module.exports = { getUserTransactions, getWheelTransactions };
