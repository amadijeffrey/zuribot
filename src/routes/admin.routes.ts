import { Router } from 'express';
import * as adminHandler from '../handlers/admin.handler';
import { authMiddleware } from '../middleware/auth';
import { adminRateLimiter } from '../middleware/rate-limit';

const router = Router();

// Apply auth and rate limit middleware to all admin routes
router.use(authMiddleware);
router.use(adminRateLimiter);

// Users
router.get('/users', adminHandler.getUsers);
router.get('/users/:id', adminHandler.getUser);
router.post('/users/:id/resend-link', adminHandler.resendGroupLink);
router.post('/users/:id/send-message', adminHandler.sendMessageToUser);

// Subscriptions
router.get('/subscriptions', adminHandler.getSubscriptionsHandler);
router.post('/subscriptions/:id/extend', adminHandler.extendSubscription);

// Payments
router.get('/payments', adminHandler.getPayments);

// Groups
router.get('/groups', adminHandler.getGroups);
router.post('/groups', adminHandler.createGroup);
router.put('/groups/:id', adminHandler.updateGroup);

// Stats & Broadcast
router.get('/stats', adminHandler.getStats);
router.post('/broadcast', adminHandler.broadcast);

export default router;