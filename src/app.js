const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();

// Security headers
app.use(helmet());

// CORS — only allow the configured client origin
app.use(
  cors({
    origin: process.env.CLIENT_URL,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Body parsing
app.use(express.json());

// Global rate limiter: 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,  // Return rate-limit info in RateLimit-* headers
  legacyHeaders: false,
  message: { message: 'Too many requests from this IP. Please try again after 15 minutes.' },
});
app.use(limiter);

// Health check — useful for load balancers and container orchestration
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

// Routes
const authRouter = require('./routes/auth.routes');
app.use('/api/auth', authRouter);

const spinWheelRouter = require('./routes/spinWheel.routes');
app.use('/api/wheels', spinWheelRouter);

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ message: 'Route not found.' });
});

// Global error handler — catches anything that slips past controllers
app.use((err, _req, res, _next) => {
  console.error('[App] Unhandled error:', err);
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    message: err.isOperational ? err.message : 'Internal server error',
  });
});

module.exports = app;
