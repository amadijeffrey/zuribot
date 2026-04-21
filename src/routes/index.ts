import { Router } from 'express';
import webhookRoutes from './webhook.routes';
import paystackRoutes from './paystack.routes';
import adminRoutes from './admin.routes';

const router = Router();

// Health check
router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'zuribot',
  });
});

// Mount routes
router.use('/', webhookRoutes);
router.use('/', paystackRoutes);
router.use('/admin', adminRoutes);

export default router;
