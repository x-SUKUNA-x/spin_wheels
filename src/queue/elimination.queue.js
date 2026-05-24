'use strict';

const { Queue, Worker } = require('bullmq');
const { redisConfig } = require('../config/redis');
const logger = require('../config/logger');

// We use lazy requires for the elimination service to avoid circular dependencies
function eliminationService() {
  return require('../services/elimination.service');
}

// Create queues
const autoStartQueue = new Queue('wheel-autostart', { connection: redisConfig });
const eliminationQueue = new Queue('wheel-elimination', { connection: redisConfig });

// Auto-start worker: fires when a wheel should automatically start
const autoStartWorker = new Worker('wheel-autostart', async (job) => {
  const { wheelId } = job.data;
  logger.info(`[BullMQ] Auto-start job processing for wheel ${wheelId}`);
  try {
    await eliminationService().startWheel(wheelId, true);
  } catch (error) {
    logger.error(`[BullMQ] Auto-start job failed for wheel ${wheelId}:`, error);
    throw error;
  }
}, { connection: redisConfig });

// Elimination worker: fires at each step to eliminate a participant
const eliminationWorker = new Worker('wheel-elimination', async (job) => {
  const { wheelId, currentOrder, participants, intervalSeconds } = job.data;
  logger.info(`[BullMQ] Elimination job processing for wheel ${wheelId}, order ${currentOrder}`);
  try {
    await eliminationService().executeEliminationStep(wheelId, currentOrder, participants, intervalSeconds);
  } catch (error) {
    logger.error(`[BullMQ] Elimination job failed for wheel ${wheelId}:`, error);
    throw error;
  }
}, { connection: redisConfig });

autoStartWorker.on('failed', (job, err) => {
  logger.error(`Auto-start job ${job.id} failed: ${err.message}`);
});

eliminationWorker.on('failed', (job, err) => {
  logger.error(`Elimination job ${job.id} failed: ${err.message}`);
});

module.exports = {
  autoStartQueue,
  eliminationQueue
};
