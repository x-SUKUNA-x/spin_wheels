'use strict';

const { query } = require('../config/db');
const logger = require('../config/logger');
const { autoStartQueue, eliminationQueue } = require('../queue/elimination.queue');

// Lazy load
function eliminationService() {
  return require('./elimination.service');
}

/**
 * Recovers wheels that were left in 'waiting' or 'spinning' state during a crash.
 */
async function recoverWheels() {
  logger.info('[Recovery] Checking for active wheels to recover...');

  try {
    // 1. Find all active wheels
    const activeWheels = await query(
      `SELECT id, status, created_at, started_at FROM spin_wheels WHERE status IN ('waiting', 'spinning')`
    );

    if (activeWheels.rows.length === 0) {
      logger.info('[Recovery] No active wheels found.');
      return;
    }

    const wheel = activeWheels.rows[0]; // Assuming max 1 active wheel
    logger.info(`[Recovery] Found active wheel ${wheel.id} in status ${wheel.status}`);

    if (wheel.status === 'waiting') {
      // It's waiting. Let's see if there is a pending autostart job.
      const jobs = await autoStartQueue.getDelayed();
      const hasJob = jobs.some(j => j.data.wheelId === wheel.id);
      if (!hasJob) {
        logger.info(`[Recovery] Wheel ${wheel.id} is waiting but has no autostart job. Triggering immediate start check.`);
        // To be safe, just attempt to start it. It will validate max/min participants inside.
        await eliminationService().startWheel(wheel.id, true);
      }
    } else if (wheel.status === 'spinning') {
      // It's spinning. It may have been in the middle of eliminations.
      // Easiest robust approach: just call a resume function that calculates where we left off.
      logger.info(`[Recovery] Resuming spinning wheel ${wheel.id}...`);
      await eliminationService().resumeSpinningWheel(wheel.id);
    }

  } catch (error) {
    logger.error('[Recovery] Failed to recover wheels:', error);
  }
}

module.exports = {
  recoverWheels
};
