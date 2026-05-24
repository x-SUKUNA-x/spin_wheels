'use strict';

const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    process.env.NODE_ENV === 'production'
      ? winston.format.json()
      : winston.format.simple()
  ),
  defaultMeta: { service: 'spinwheel-backend' },
  transports: [
    new winston.transports.Console()
  ],
});

module.exports = logger;
