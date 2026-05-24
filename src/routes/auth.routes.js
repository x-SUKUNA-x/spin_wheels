const { Router } = require('express');
const { authenticate } = require('../middlewares/auth');
const { register, login, getMe, refresh } = require('../controllers/auth.controller');
const { authValidators } = require('../middlewares/validator');

const router = Router();

router.post('/register', authValidators.register, register);
router.post('/login', authValidators.login, login);
router.post('/refresh', authValidators.refresh, refresh);
router.get('/me', authenticate, getMe);

module.exports = router;
