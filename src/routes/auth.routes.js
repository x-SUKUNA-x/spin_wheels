const { Router } = require('express');
const { authenticate } = require('../middlewares/auth');
const { register, login, getMe } = require('../controllers/auth.controller');

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.get('/me', authenticate, getMe);

module.exports = router;
