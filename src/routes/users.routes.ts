import { Router } from 'express';
import { register, registrationStatus, listPlans } from '../handlers/user.handler';
import { apiRateLimiter } from '../middleware/rate-limit';

const router = Router();

// Public web-registration endpoints (rate limited — they create users and hit Paystack).
router.get('/plans', apiRateLimiter, listPlans);
router.post('/register', apiRateLimiter, register);
router.get('/registration-status', apiRateLimiter, registrationStatus);

export default router;
