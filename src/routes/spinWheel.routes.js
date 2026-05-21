const { Router } = require('express');
const { authenticate } = require('../middlewares/auth');
const {
  createWheel,
  joinWheel,
  getWheel,
  getActiveWheel,
} = require('../controllers/spinWheel.controller');

const router = Router();

// All spin wheel routes require a valid JWT
router.use(authenticate);

// POST /api/wheels       — create a new wheel (admin only, enforced in controller)
router.post('/', createWheel);

// POST /api/wheels/:wheelId/join — join a wheel
router.post('/:wheelId/join', joinWheel);

// GET  /api/wheels/active — must come BEFORE /:wheelId to avoid 'active' being treated as an ID
router.get('/active', getActiveWheel);

// GET  /api/wheels/:wheelId — get wheel + participants
router.get('/:wheelId', getWheel);

module.exports = router;
