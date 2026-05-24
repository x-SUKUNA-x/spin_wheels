'use strict';
/**
 * src/services/elimination.service.js
 * -------------------------------------
 * Core game engine: manages the auto-start timer and the elimination loop.
 * All state is in-memory (Map). Every timer reference is cleaned up on
 * wheel completion or abort to prevent memory leaks.
 *
 * Key design decisions:
 *  - startWheel() guards against double-start by checking DB status.
 *  - abortWheel() and finalizeWinner() wrap all coin ops in a single
 *    DB transaction — any credit failure rolls everything back.
 *  - Socket emissions are fire-and-forget; errors are caught and logged
 *    so they can never crash the elimination loop.
 *  - Fisher-Yates shuffle uses Math.random() (true random per call).
 */

const { pool, query }        = require('../config/db');
const { creditCoins }        = require('./coin.service');
const { getParticipantCount, getConfig, getWheelById } = require('./spinWheel.service');
const { emitToWheel, emitToUser, emitToAll } = require('../socket/index');
const crypto = require('crypto');
const autoStartTimers = new Map();
const eliminationTimers = new Map();// ── Fisher-Yates shuffle ─────────────────────────────────────────────────────

/**
 * In-place deterministic shuffle using a cryptographic seed.
 * @template T
 * @param {T[]} arr
 * @param {string} seed
 * @returns {T[]} The same array, shuffled deterministically.
 */
function seededShuffle(arr, seed) {
  let currentSeed = crypto.createHash('sha256').update(seed).digest('hex');
  for (let i = arr.length - 1; i > 0; i--) {
    // Use first 8 hex characters (32 bits)
    const randInt = parseInt(currentSeed.substring(0, 8), 16);
    const j = randInt % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
    currentSeed = crypto.createHash('sha256').update(currentSeed).digest('hex');
  }
  return arr;
}

// ── Timer helpers ─────────────────────────────────────────────────────────────

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Schedule the auto-start timer for a wheel.
 * Replaces any existing timer for the same wheelId.
 * @param {string} wheelId
 * @param {number} delaySeconds
 */
async function scheduleAutoStart(wheelId, delaySeconds) {
  console.log(`[Elimination] Auto-start scheduled for wheel ${wheelId} in ${delaySeconds}s`);

  if (autoStartTimers.has(wheelId)) {
    clearTimeout(autoStartTimers.get(wheelId));
  }

  const timer = setTimeout(async () => {
    autoStartTimers.delete(wheelId);
    await startWheel(wheelId, true);
  }, delaySeconds * 1000);

  autoStartTimers.set(wheelId, timer);
}

/**
 * Cancel the auto-start timer for a wheel (called when admin starts manually
 * or the wheel is aborted before it fires).
 * @param {string} wheelId
 */
async function cancelAutoStart(wheelId) {
  if (autoStartTimers.has(wheelId)) {
    clearTimeout(autoStartTimers.get(wheelId));
    autoStartTimers.delete(wheelId);
    console.log(`[Elimination] Auto-start timer cancelled for wheel ${wheelId}`);
  }
}

/**
 * Start a wheel: validate state, generate elimination order, kick off loop.
 * Safe to call from a timer — never throws; logs errors instead.
 *
 * @param {string}  wheelId
 * @param {boolean} isAutoStart - true when triggered by the auto-start timer
 */
async function startWheel(wheelId, isAutoStart = false) {
  try {
    // ── 1. Guard: only start if status is 'waiting' ─────────────────────────
    const wheel = await getWheelById(wheelId);
    if (!wheel) {
      console.warn(`[Elimination] startWheel: wheel ${wheelId} not found — aborting`);
      return;
    }
    if (wheel.status !== 'waiting') {
      console.warn(`[Elimination] startWheel: wheel ${wheelId} is "${wheel.status}" — skipping`);
      return;
    }

    // ── 2. Check minimum participants ────────────────────────────────────────
    const participantCount = await getParticipantCount(wheelId);
    const config = await getConfig();

    if (participantCount < config.min_participants) {
      console.log(`[Elimination] Wheel ${wheelId}: only ${participantCount}/${config.min_participants} participants — aborting`);
      await abortWheel(wheelId, 'Not enough participants');
      return;
    }

    // ── 3. Fetch all participants and generate elimination sequence ───────────
    const pResult = await query(
      'SELECT id, user_id FROM spin_wheel_participants WHERE spin_wheel_id = $1',
      [wheelId],
    );
    const participants = pResult.rows; // [{ id, user_id }, ...]

    // Generate client seed if not provided (for now just randomly generate it)
    const clientSeed = crypto.randomBytes(16).toString('hex');
    const combinedSeed = `${wheel.server_seed}:${clientSeed}`;
    const finalHash = crypto.createHash('sha256').update(combinedSeed).digest('hex');

    // Shuffle — last element is the winner (never gets an elimination_order)
    seededShuffle(participants, finalHash);

    const toEliminate = participants.slice(0, participants.length - 1); // everyone except last
    // The winner is the last element after shuffle; identity tracked via elimination_order IS NULL in DB

    // Assign elimination_order 1..N to losers
    for (let i = 0; i < toEliminate.length; i++) {
      await query(
        'UPDATE spin_wheel_participants SET elimination_order = $1 WHERE id = $2',
        [i + 1, toEliminate[i].id],
      );
    }

    // ── 4. Mark wheel as spinning and save final seeds ────────────────────────
    await query(
      `UPDATE spin_wheels 
       SET status = 'spinning', started_at = now(), updated_at = now(),
           client_seed = $2, final_hash = $3
       WHERE id = $1`,
      [wheelId, clientSeed, finalHash],
    );

    // ── 5. Emit wheel:started ────────────────────────────────────────────────
    emitToWheel(wheelId, 'wheel:started', {
      wheelId,
      participantCount,
      eliminationOrder: participants.map((p) => p.user_id),
    });
    emitToAll('wheel:new_active', { wheelId });

    console.log(`[Elimination] Wheel ${wheelId} started (auto=${isAutoStart}), ${participantCount} participants`);

    await scheduleNextElimination(
      wheelId,
      1,
      toEliminate.map((p, i) => ({ ...p, elimination_order: i + 1 })),
      config.elimination_interval_seconds,
    );
  } catch (err) {
    console.error(`[Elimination] startWheel error for wheel ${wheelId}:`, err.message);
  }
}

/**
 * Schedule the next elimination step via BullMQ.
 *
 * @param {string} wheelId
 * @param {number} currentOrder
 * @param {Array}  participants
 * @param {number} intervalSeconds
 */
async function scheduleNextElimination(wheelId, currentOrder, participants, intervalSeconds) {
  if (currentOrder > participants.length) {
    await finalizeWinner(wheelId);
    return;
  }

  const timer = setTimeout(async () => {
    eliminationTimers.delete(wheelId);
    await executeEliminationStep(wheelId, currentOrder, participants, intervalSeconds);
  }, intervalSeconds * 1000);

  eliminationTimers.set(wheelId, timer);
}

/**
 * Execute one step of elimination (called by the BullMQ worker).
 */
async function executeEliminationStep(wheelId, currentOrder, participants, intervalSeconds) {
  const target = participants.find((p) => p.elimination_order === currentOrder);
  if (!target) {
    console.error(`[Elimination] No participant with elimination_order=${currentOrder} for wheel ${wheelId}`);
    return;
  }

  await query(
    `UPDATE spin_wheel_participants
     SET eliminated_at = now()
     WHERE spin_wheel_id = $1 AND elimination_order = $2 AND eliminated_at IS NULL`,
    [wheelId, currentOrder],
  );

  const remainingCount = participants.length - currentOrder;
  emitToWheel(wheelId, 'wheel:elimination', {
    wheelId,
    eliminatedUserId: target.user_id,
    eliminationOrder: currentOrder,
    remainingCount,
  });
  emitToUser(target.user_id, 'wheel:you_were_eliminated', {
    wheelId,
    eliminationOrder: currentOrder,
  });

  console.log(`[Elimination] Wheel ${wheelId}: eliminated order ${currentOrder}, remaining=${remainingCount}`);

  await scheduleNextElimination(wheelId, currentOrder + 1, participants, intervalSeconds);
}

/**
 * Recovers a spinning wheel by finding the next elimination step.
 */
async function resumeSpinningWheel(wheelId) {
  const pResult = await query(
    'SELECT id, user_id, elimination_order, eliminated_at FROM spin_wheel_participants WHERE spin_wheel_id = $1 ORDER BY elimination_order ASC',
    [wheelId],
  );
  
  const participants = pResult.rows.filter(p => p.elimination_order !== null);
  
  // Find the first participant who is NOT eliminated
  const nextTarget = participants.find(p => p.eliminated_at === null);
  const config = await getConfig();

  if (nextTarget) {
    console.log(`[Elimination] Resuming wheel ${wheelId} at order ${nextTarget.elimination_order}`);
    await scheduleNextElimination(wheelId, nextTarget.elimination_order, participants, config.elimination_interval_seconds);
  } else {
    // All eliminations done, but winner not finalized
    console.log(`[Elimination] Resuming wheel ${wheelId} - finalizing winner directly`);
    await finalizeWinner(wheelId);
  }
}

/**
 * Cancel any pending eliminations (called during abort).
 */
async function cancelEliminationInterval(wheelId) {
  if (eliminationTimers.has(wheelId)) {
    clearTimeout(eliminationTimers.get(wheelId));
    eliminationTimers.delete(wheelId);
  }
}

/**
 * Abort a wheel: refund all participants, mark as aborted, emit event.
 * All refunds are in a single DB transaction.
 *
 * @param {string} wheelId
 * @param {string} [reason='Wheel aborted']
 */
async function abortWheel(wheelId, reason = 'Wheel aborted') {
  console.log(`[Elimination] Aborting wheel ${wheelId}: ${reason}`);

  try {
    // 1. Fetch wheel to get entry_fee_snapshot
    const wheel = await getWheelById(wheelId);
    if (!wheel) {
      console.warn(`[Elimination] abortWheel: wheel ${wheelId} not found`);
      return;
    }

    // Guard: skip if already in a terminal state (prevents double-refund on concurrent calls)
    if (['aborted', 'completed'].includes(wheel.status)) {
      console.warn(`[Elimination] abortWheel: wheel ${wheelId} is already "${wheel.status}" — skipping`);
      return;
    }

    // 2. Mark as aborted
    await query(
      `UPDATE spin_wheels SET status = 'aborted', completed_at = now(), updated_at = now() WHERE id = $1`,
      [wheelId],
    );

    // 3. Fetch all participants for refund
    const pResult = await query(
      'SELECT user_id FROM spin_wheel_participants WHERE spin_wheel_id = $1',
      [wheelId],
    );
    const participants = pResult.rows;

    // 4. Refund all in a single transaction
    if (participants.length > 0) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const p of participants) {
          await creditCoins(
            client,
            p.user_id,
            parseFloat(wheel.entry_fee_snapshot),
            wheelId,
            'refund',
            'Spin wheel aborted — entry fee refunded',
          );
        }
        await client.query('COMMIT');
        console.log(`[Elimination] Refunded ${participants.length} participants for wheel ${wheelId}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[Elimination] Refund transaction failed for wheel ${wheelId}:`, err.message);
        throw err;
      } finally {
        client.release();
      }
    }

    // 5. Emit and clean up
    emitToWheel(wheelId, 'wheel:aborted', { wheelId, reason, refundedCount: participants.length });
    // Cancel any active timers
    await cancelAutoStart(wheelId);
    await cancelEliminationInterval(wheelId);
  } catch (err) {
    console.error(`[Elimination] abortWheel error for wheel ${wheelId}:`, err.message);
  }
}

/**
 * Finalize the winner: credit winner + admin, mark completed, emit event.
 * All credits in a single DB transaction.
 *
 * @param {string} wheelId
 */
async function finalizeWinner(wheelId) {
  console.log(`[Elimination] Finalizing winner for wheel ${wheelId}`);

  try {
    const wheel = await getWheelById(wheelId);
    if (!wheel) {
      console.error(`[Elimination] finalizeWinner: wheel ${wheelId} not found`);
      return;
    }

    // Guard: only pay out once — prevents double-credit if called concurrently
    if (wheel.status !== 'spinning') {
      console.warn(`[Elimination] finalizeWinner: wheel ${wheelId} is "${wheel.status}" — skipping (already finalized?)`);
      return;
    }

    // Find the winner: the participant with no elimination_order
    const winnerResult = await query(
      'SELECT user_id FROM spin_wheel_participants WHERE spin_wheel_id = $1 AND elimination_order IS NULL',
      [wheelId],
    );

    if (winnerResult.rows.length === 0) {
      console.error(`[Elimination] finalizeWinner: no winner found for wheel ${wheelId}`);
      return;
    }

    const winnerUserId = winnerResult.rows[0].user_id;
    const winnerAmount = parseFloat(wheel.winner_pool_accumulated);
    const adminAmount  = parseFloat(wheel.admin_pool_accumulated);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Credit winner
      await creditCoins(
        client,
        winnerUserId,
        winnerAmount,
        wheelId,
        'winner_credit',
        'Spin wheel winner payout',
      );

      // Credit admin
      await creditCoins(
        client,
        wheel.created_by,
        adminAmount,
        wheelId,
        'admin_credit',
        'Spin wheel admin payout',
      );

      // Mark wheel completed
      await client.query(
        `UPDATE spin_wheels
         SET status = 'completed', winner_user_id = $1, completed_at = now(), updated_at = now()
         WHERE id = $2`,
        [winnerUserId, wheelId],
      );

      await client.query('COMMIT');
      console.log(`[Elimination] Wheel ${wheelId} completed. Winner: ${winnerUserId}, prize: ${winnerAmount}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[Elimination] finalizeWinner transaction failed for wheel ${wheelId}:`, err.message);
      throw err;
    } finally {
      client.release();
    }

    emitToWheel(wheelId, 'wheel:completed', {
      wheelId,
      winnerUserId,
      winnerAmount,
      adminAmount,
    });
    emitToUser(winnerUserId, 'wheel:you_won', {
      wheelId,
      amount: winnerAmount,
    });

    // Clean up
    await cancelEliminationInterval(wheelId);
  } catch (err) {
    console.error(`[Elimination] finalizeWinner error for wheel ${wheelId}:`, err.message);
  }
}

module.exports = {
  scheduleAutoStart,
  cancelAutoStart,
  startWheel,
  abortWheel,
  executeEliminationStep,
  resumeSpinningWheel,
  finalizeWinner,
};
