'use strict';

const Redis = require('ioredis');
const logger = require('./logger');

const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
};

const redisClient = new Redis(redisConfig);
const redisSubscriber = new Redis(redisConfig);

redisClient.on('connect', () => logger.info('[Redis] Client connected'));
redisClient.on('error', (err) => logger.error('[Redis] Client error:', err));

redisSubscriber.on('connect', () => logger.info('[Redis] Subscriber connected'));
redisSubscriber.on('error', (err) => logger.error('[Redis] Subscriber error:', err));

module.exports = {
  redisClient,
  redisSubscriber,
  redisConfig,
};
