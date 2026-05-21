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
const { getIo }              = require('../socket/index');

// ── Module-level timer state ────────────────────────────────────────────────
// wheelId → { autoStartTimer: Timeout|null, eliminationInterval: Timeout|null }
const activeTimers = new Map();

// ── Socket helper ────────────────────────────────────────────────────────────

/**
 * Emit a socket event. Never throws — failures are just logged.
 * @param {string} event
 * @param {object} payload
 */
function emit(event, payload) {
  try {
    const io = getIo();
    if (io) io.emit(event, payload);
  } catch (err) {
    console.error(`[Elimination] Socket emit failed for "${event}":`, err.message);
  }
}

// ── Fisher-Yates shuffle ─────────────────────────────────────────────────────

/**
 * In-place Fisher-Yates shuffle.
 * @template T
 * @param {T[]} arr
 * @returns {T[]} The same array, shuffled.
 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Timer helpers ─────────────────────────────────────────────────────────────

/**
 * Ensure an entry exists in activeTimers for this wheel.
 * @param {string} wheelId
 */
function ensureTimerEntry(wheelId) {
  if (!activeTimers.has(wheelId)) {
    activeTimers.set(wheelId, { autoStartTimer: null, eliminationInterval: null });
  }
}

/**
 * Clean up all timers for a wheel and remove its entry from the map.
 * @param {string} wheelId
 */
function cleanupTimers(wheelId) {
  const entry = activeTimers.get(wheelId);
  if (!entry) return;
  if (entry.autoStartTimer)    clearTimeout(entry.autoStartTimer);
  if (entry.eliminationInterval) clearTimeout(entry.eliminationInterval);
  activeTimers.delete(wheelId);
  console.log(`[Elimination] Timers cleaned up for wheel ${wheelId}`);
}

// ── Exported functions ────────────────────────────────────────────────────────

/**
 * Schedule the auto-start timer for a wheel.
 * Replaces any existing timer for the same wheelId.
 * @param {string} wheelId
 * @param {number} delaySeconds
 */
function scheduleAutoStart(wheelId, delaySeconds) {
  ensureTimerEntry(wheelId);
  const entry = activeTimers.get(wheelId);

  // Clear any previous auto-start timer for this wheel
  if (entry.autoStartTimer) {
    clearTimeout(entry.autoStartTimer);
    entry.autoStartTimer = null;
  }

  console.log(`[Elimination] Auto-start scheduled for wheel ${wheelId} in ${delaySeconds}s`);

  entry.autoStartTimer = setTimeout(async () => {
    try {
      console.log(`[Elimination] Auto-start timer fired for wheel ${wheelId}`);
      await startWheel(wheelId, true);
    } catch (err) {
      console.error(`[Elimination] Auto-start callback error for wheel ${wheelId}:`, err.message);
    }
  }, delaySeconds * 1000);
}

/**
 * Cancel the auto-start timer for a wheel (called when admin starts manually
 * or the wheel is aborted before it fires).
 * @param {string} wheelId
 */
function cancelAutoStart(wheelId) {
  const entry = activeTimers.get(wheelId);
  if (!entry) return;
  if (entry.autoStartTimer) {
    clearTimeout(entry.autoStartTimer);
    entry.autoStartTimer = null;
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

    // Shuffle — last element is the winner (never gets an elimination_order)
    shuffle(participants);

    const toEliminate = participants.slice(0, participants.length - 1); // everyone except last
    // The winner is the last element after shuffle; identity tracked via elimination_order IS NULL in DB

    // Assign elimination_order 1..N to losers
    for (let i = 0; i < toEliminate.length; i++) {
      await query(
        'UPDATE spin_wheel_participants SET elimination_order = $1 WHERE id = $2',
        [i + 1, toEliminate[i].id],
      );
    }

    // ── 4. Mark wheel as spinning ────────────────────────────────────────────
    await query(
      `UPDATE spin_wheels SET status = 'spinning', started_at = now(), updated_at = now() WHERE id = $1`,
      [wheelId],
    );

    // ── 5. Emit wheel:started ────────────────────────────────────────────────
    emit('wheel:started', {
      wheelId,
      participantCount,
      eliminationOrder: participants.map((p) => p.user_id), // shuffled order
    });

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
 * Schedule the next elimination step.
 *
 * @param {string} wheelId
 * @param {number} currentOrder         - The elimination_order to fire next
 * @param {Array}  participants         - All participants-to-eliminate, each with { user_id, elimination_order }
 * @param {number} intervalSeconds
 */
async function scheduleNextElimination(wheelId, currentOrder, participants, intervalSeconds) {
  // All eliminations done — find the winner
  if (currentOrder > participants.length) {
    await finalizeWinner(wheelId);
    return;
  }

  ensureTimerEntry(wheelId);

  const timer = setTimeout(async () => {
    try {
      const target = participants.find((p) => p.elimination_order === currentOrder);
      if (!target) {
        console.error(`[Elimination] No participant with elimination_order=${currentOrder} for wheel ${wheelId}`);
        return;
      }

      // Mark participant as eliminated
      await query(
        `UPDATE spin_wheel_participants
         SET eliminated_at = now()
         WHERE spin_wheel_id = $1 AND elimination_order = $2`,
        [wheelId, currentOrder],
      );

      const remainingCount = participants.length - currentOrder; // excludes winner
      emit('wheel:elimination', {
        wheelId,
        eliminatedUserId: target.user_id,
        eliminationOrder: currentOrder,
        remainingCount,
      });

      console.log(`[Elimination] Wheel ${wheelId}: eliminated order ${currentOrder}, remaining=${remainingCount}`);

      // Schedule next
      await scheduleNextElimination(wheelId, currentOrder + 1, participants, intervalSeconds);
    } catch (err) {
      console.error(`[Elimination] Elimination step error (order=${currentOrder}, wheel=${wheelId}):`, err.message);
    }
  }, intervalSeconds * 1000);

  // Store the latest interval timer so it can be cancelled if needed
  const entry = activeTimers.get(wheelId);
  if (entry) entry.eliminationInterval = timer;
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
    emit('wheel:aborted', { wheelId, reason, refundedCount: participants.length });
    cancelAutoStart(wheelId);
    cleanupTimers(wheelId);
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

    emit('wheel:completed', {
      wheelId,
      winnerUserId,
      winnerAmount,
      adminAmount,
    });

    cleanupTimers(wheelId);
  } catch (err) {
    console.error(`[Elimination] finalizeWinner error for wheel ${wheelId}:`, err.message);
  }
}

module.exports = {
  scheduleAutoStart,
  cancelAutoStart,
  startWheel,
  abortWheel,
  finalizeWinner,
};
