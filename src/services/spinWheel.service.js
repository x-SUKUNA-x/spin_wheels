const { pool, query } = require('../config/db');
const { debitCoins } = require('./coin.service');
const AppError = require('../utils/AppError');

// Lazy-require to avoid circular dependency at module load time.
// elimination.service → spinWheel.service (getWheelById, etc.)
// spinWheel.service   → elimination.service (scheduleAutoStart, etc.)
// Using a getter function breaks the cycle.
function eliminationService() {
  return require('./elimination.service');
}

// Lazy-require socket helpers to avoid circular dependency issues.
const getSocketHelpers = () => require('../socket/index');

/**
 * Fetch the currently active spin wheel (status 'waiting' or 'spinning').
 * @returns {Object|null} Wheel row or null if none exists.
 */
async function getActiveWheel() {
  const result = await query(
    `SELECT * FROM spin_wheels WHERE status IN ('waiting', 'spinning') LIMIT 1`,
    [],
  );
  return result.rows[0] || null;
}

/**
 * Fetch a spin wheel by its primary key.
 * @param {string} id - UUID of the spin wheel.
 * @returns {Object|null} Wheel row or null if not found.
 */
async function getWheelById(id) {
  const result = await query(
    'SELECT * FROM spin_wheels WHERE id = $1',
    [id],
  );
  return result.rows[0] || null;
}

/**
 * Fetch a spin wheel together with its participants and their user details.
 * @param {string} wheelId - UUID of the spin wheel.
 * @returns {Object|null} Wheel object with a `participants` array, or null if not found.
 */
async function getWheelWithParticipants(wheelId) {
  const result = await query(
    `SELECT
       sw.*,
       swp.id            AS participant_id,
       swp.user_id,
       u.username,
       swp.joined_at,
       swp.elimination_order,
       swp.eliminated_at
     FROM spin_wheels sw
     LEFT JOIN spin_wheel_participants swp ON swp.spin_wheel_id = sw.id
     LEFT JOIN users u ON u.id = swp.user_id
     WHERE sw.id = $1
     ORDER BY swp.joined_at ASC`,
    [wheelId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  // The first row always contains the wheel columns; participant columns may be NULL
  // when there are no participants (LEFT JOIN with no matches).
  const firstRow = result.rows[0];

  const wheel = {
    id: firstRow.id,
    status: firstRow.status,
    createdBy: firstRow.created_by,
    entryFeeSnapshot: firstRow.entry_fee_snapshot,
    winnerPoolPercentSnapshot: firstRow.winner_pool_percent_snapshot,
    adminPoolPercentSnapshot: firstRow.admin_pool_percent_snapshot,
    appPoolPercentSnapshot: firstRow.app_pool_percent_snapshot,
    winnerPoolAccumulated: firstRow.winner_pool_accumulated,
    adminPoolAccumulated: firstRow.admin_pool_accumulated,
    appPoolAccumulated: firstRow.app_pool_accumulated,
    createdAt: firstRow.created_at,
    updatedAt: firstRow.updated_at,
  };

  // Build participants array, filtering out the null row from an empty LEFT JOIN
  const participants = result.rows
    .filter((row) => row.participant_id !== null)
    .map((row) => ({
      participantId: row.participant_id,
      userId: row.user_id,
      username: row.username,
      joinedAt: row.joined_at,
      eliminationOrder: row.elimination_order,
      eliminatedAt: row.eliminated_at,
    }));

  return { ...wheel, participants };
}

/**
 * Fetch the single configuration row from spin_wheel_config.
 * @returns {Object} Config row as a plain object.
 */
async function getConfig() {
  const result = await query('SELECT * FROM spin_wheel_config LIMIT 1', []);
  if (result.rows.length === 0) {
    throw new AppError('Spin wheel configuration not found.', 500, 'CONFIG_NOT_FOUND');
  }
  return result.rows[0];
}

/**
 * Create a new spin wheel (admin only).
 * Throws if another wheel is already active.
 * @param {string} adminUserId - UUID of the admin creating the wheel.
 * @returns {Object} Newly created spin wheel row.
 */
async function createWheel(adminUserId) {
  // Guard: only one active wheel at a time
  const existing = await getActiveWheel();
  if (existing) {
    throw new AppError('A spin wheel is already active', 409, 'WHEEL_ALREADY_ACTIVE');
  }

  const config = await getConfig();

  const result = await query(
    `INSERT INTO spin_wheels
       (created_by, status,
        entry_fee_snapshot,
        winner_pool_percent_snapshot,
        admin_pool_percent_snapshot,
        app_pool_percent_snapshot)
     VALUES ($1, 'waiting', $2, $3, $4, $5)
     RETURNING *`,
    [
      adminUserId,
      config.entry_fee,
      config.winner_pool_percent,
      config.admin_pool_percent,
      config.app_pool_percent,
    ],
  );

  const wheel = result.rows[0];

  // Schedule the auto-start timer — fires after config.auto_start_seconds
  eliminationService().scheduleAutoStart(wheel.id, config.auto_start_seconds);

  // Notify all connected clients that a new wheel is available
  const { emitToAll } = getSocketHelpers();
  emitToAll('wheel:created', {
    wheelId: wheel.id,
    entryFee: wheel.entry_fee_snapshot,
  });

  return wheel;
}

/**
 * Join a spin wheel.
 * Wraps all operations in a single database transaction.
 * @param {string} userId   - UUID of the user joining.
 * @param {string} wheelId  - UUID of the target spin wheel.
 * @returns {{ participant: Object, updatedWheel: Object }}
 */
async function joinWheel(userId, wheelId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Lock the wheel row to prevent concurrent race conditions
    const wheelResult = await client.query(
      'SELECT * FROM spin_wheels WHERE id = $1 FOR UPDATE',
      [wheelId],
    );

    if (wheelResult.rows.length === 0) {
      throw new AppError('Spin wheel not found', 404, 'WHEEL_NOT_FOUND');
    }

    const wheel = wheelResult.rows[0];

    if (wheel.status !== 'waiting') {
      throw new AppError('This wheel is no longer accepting participants', 400, 'WHEEL_NOT_WAITING');
    }

    // 2. Duplicate-join guard
    const existingParticipant = await client.query(
      'SELECT id FROM spin_wheel_participants WHERE spin_wheel_id = $1 AND user_id = $2',
      [wheelId, userId],
    );

    if (existingParticipant.rows.length > 0) {
      throw new AppError('You have already joined this wheel', 409, 'ALREADY_JOINED');
    }

    // 3. Debit entry fee — coin.service owns the INSERT into transactions
    await debitCoins(
      client,
      userId,
      parseFloat(wheel.entry_fee_snapshot),
      wheelId,
      'entry_fee_debit',
      'Entry fee for spin wheel',
    );

    // 4. Update pool accumulators using pure PostgreSQL arithmetic (NUMERIC precision)
    const updatedWheelResult = await client.query(
      `UPDATE spin_wheels SET
         winner_pool_accumulated = winner_pool_accumulated + (entry_fee_snapshot * winner_pool_percent_snapshot / 100.0),
         admin_pool_accumulated  = admin_pool_accumulated  + (entry_fee_snapshot * admin_pool_percent_snapshot  / 100.0),
         app_pool_accumulated    = app_pool_accumulated    + (entry_fee_snapshot * app_pool_percent_snapshot    / 100.0)
       WHERE id = $1
       RETURNING *`,
      [wheelId],
    );

    const updatedWheel = updatedWheelResult.rows[0];

    // 5. Register participant
    const participantResult = await client.query(
      `INSERT INTO spin_wheel_participants (spin_wheel_id, user_id, joined_at)
       VALUES ($1, $2, now())
       RETURNING *`,
      [wheelId, userId],
    );

    const participant = participantResult.rows[0];

    await client.query('COMMIT');

    // Notify all clients in the wheel room that someone joined
    const { emitToWheel } = getSocketHelpers();
    emitToWheel(wheelId, 'wheel:participant_joined', {
      wheelId,
      userId,
      participantCount: await getParticipantCount(wheelId),
    });

    return { participant, updatedWheel };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Count participants in a spin wheel.
 * @param {string} wheelId - UUID of the spin wheel.
 * @returns {number} Number of participants.
 */
async function getParticipantCount(wheelId) {
  const result = await query(
    'SELECT COUNT(*) AS count FROM spin_wheel_participants WHERE spin_wheel_id = $1',
    [wheelId],
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Manually start a wheel (admin only).
 * Cancels the auto-start timer, then calls the elimination engine.
 *
 * @param {string} adminUserId
 * @param {string} wheelId
 * @returns {Object} Updated wheel row
 */
async function manualStartWheel(adminUserId, wheelId) {
  // Verify admin role from DB (don't trust token alone for destructive actions)
  const userResult = await query('SELECT role FROM users WHERE id = $1', [adminUserId]);
  if (userResult.rows.length === 0 || userResult.rows[0].role !== 'admin') {
    throw new AppError('Admin access required.', 403, 'FORBIDDEN');
  }

  const wheel = await getWheelById(wheelId);
  if (!wheel) {
    throw new AppError('Wheel not found', 404, 'WHEEL_NOT_FOUND');
  }
  if (wheel.status !== 'waiting') {
    throw new AppError('Wheel cannot be started — it is not in waiting status', 400, 'WHEEL_NOT_WAITING');
  }

  // Cancel the auto-start timer before handing control to the engine
  eliminationService().cancelAutoStart(wheelId);

  // startWheel is fire-and-forget safe, but we await here so the
  // DB status is updated before we return the response.
  await eliminationService().startWheel(wheelId, false);

  // Return the freshly updated wheel
  return await getWheelById(wheelId);
}

/**
 * Admin aborts a wheel, triggering refunds for all participants.
 *
 * @param {string} adminUserId
 * @param {string} wheelId
 * @returns {{ aborted: true }}
 */
async function adminAbortWheel(adminUserId, wheelId) {
  const userResult = await query('SELECT role FROM users WHERE id = $1', [adminUserId]);
  if (userResult.rows.length === 0 || userResult.rows[0].role !== 'admin') {
    throw new AppError('Admin access required.', 403, 'FORBIDDEN');
  }

  const wheel = await getWheelById(wheelId);
  if (!wheel) {
    throw new AppError('Wheel not found', 404, 'WHEEL_NOT_FOUND');
  }
  if (!['waiting', 'spinning'].includes(wheel.status)) {
    throw new AppError('Wheel cannot be aborted — it is already completed or aborted', 400, 'WHEEL_NOT_ABORTABLE');
  }

  await eliminationService().abortWheel(wheelId, 'Manually aborted by admin');

  return { aborted: true };
}

module.exports = {
  getActiveWheel,
  getWheelById,
  getWheelWithParticipants,
  getConfig,
  createWheel,
  joinWheel,
  getParticipantCount,
  manualStartWheel,
  adminAbortWheel,
};
