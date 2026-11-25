import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  redisHost: process.env.REDIS_HOST || 'redis',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  reconciliationIntervalMs: parseInt(
    process.env.RECONCILIATION_INTERVAL_MS || '300000',
    10,
  ),
  processingStaleAfterMinutes: parseInt(
    process.env.PROCESSING_STALE_AFTER_MINUTES || '15',
    10,
  ),
}));
