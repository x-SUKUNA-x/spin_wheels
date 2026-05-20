const { query } = require('../config/db');
const AppError = require('../utils/AppError');

/**
 * Credit coins to a user's balance within an existing transaction.
 *
 * @param {import('pg').PoolClient} client - Active pg client (caller owns BEGIN/COMMIT)
 * @param {string}  userId
 * @param {number}  amount
 * @param {string|null} spinWheelId
 * @param {string}  type  - e.g. 'winner_credit', 'admin_credit', 'refund'
 * @param {string|null} description
 * @returns {{ newBalance: number, transactionId: string }}
 */
async function creditCoins(client, userId, amount, spinWheelId, type, description) {
  // Row-level lock prevents concurrent balance mutations
  const balanceResult = await client.query(
    'SELECT coin_balance FROM users WHERE id = $1 FOR UPDATE',
    [userId],
  );

  if (balanceResult.rows.length === 0) {
    throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
  }

  const balanceBefore = parseFloat(balanceResult.rows[0].coin_balance);
  const balanceAfter = balanceBefore + amount;

  await client.query(
    'UPDATE users SET coin_balance = $1 WHERE id = $2',
    [balanceAfter, userId],
  );

  const txResult = await client.query(
    `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, spin_wheel_id, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [userId, type, amount, balanceBefore, balanceAfter, spinWheelId, description],
  );

  return { newBalance: balanceAfter, transactionId: txResult.rows[0].id };
}

/**
 * Debit coins from a user's balance within an existing transaction.
 *
 * @param {import('pg').PoolClient} client - Active pg client (caller owns BEGIN/COMMIT)
 * @param {string}  userId
 * @param {number}  amount
 * @param {string|null} spinWheelId
 * @param {string}  type  - e.g. 'entry_fee_debit'
 * @param {string|null} description
 * @returns {{ newBalance: number, transactionId: string }}
 */
async function debitCoins(client, userId, amount, spinWheelId, type, description) {
  const balanceResult = await client.query(
    'SELECT coin_balance FROM users WHERE id = $1 FOR UPDATE',
    [userId],
  );

  if (balanceResult.rows.length === 0) {
    throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
  }

  const balanceBefore = parseFloat(balanceResult.rows[0].coin_balance);

  if (balanceBefore < amount) {
    throw new AppError('Insufficient coin balance.', 400, 'INSUFFICIENT_BALANCE');
  }

  const balanceAfter = balanceBefore - amount;

  await client.query(
    'UPDATE users SET coin_balance = $1 WHERE id = $2',
    [balanceAfter, userId],
  );

  const txResult = await client.query(
    `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, spin_wheel_id, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [userId, type, amount, balanceBefore, balanceAfter, spinWheelId, description],
  );

  return { newBalance: balanceAfter, transactionId: txResult.rows[0].id };
}

/**
 * Fetch a user's current coin balance (read-only, no lock).
 * @param {string} userId
 * @returns {number}
 */
async function getUserBalance(userId) {
  const result = await query(
    'SELECT coin_balance FROM users WHERE id = $1',
    [userId],
  );

  if (result.rows.length === 0) {
    throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
  }

  return parseFloat(result.rows[0].coin_balance);
}

module.exports = { creditCoins, debitCoins, getUserBalance };
