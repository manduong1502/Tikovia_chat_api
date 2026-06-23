const Redis = require('ioredis');
const logger = require('./logger');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
let redisClient = null;
let redisConnected = false;

try {
  logger.info(`[Redis] Đang khởi tạo kết nối đến Redis tại: ${REDIS_URL}`);
  
  redisClient = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      // Thử kết nối lại sau 2 giây
      return Math.min(times * 100, 2000);
    }
  });

  redisClient.on('connect', () => {
    redisConnected = true;
    logger.info('[Redis] Kết nối thành công đến dịch vụ Redis.');
  });

  redisClient.on('error', (err) => {
    redisConnected = false;
    logger.error('[Redis] Lỗi kết nối Redis. Hệ thống sẽ tự động chuyển sang chế độ dự phòng (Fallback):', err);
  });

  redisClient.on('close', () => {
    redisConnected = false;
    logger.warn('[Redis] Kết nối Redis đã bị đóng.');
  });

} catch (error) {
  redisConnected = false;
  logger.error('[Redis] Lỗi bất ngờ khi khởi tạo Redis Client:', error);
}

// Helper kiểm tra trạng thái hoạt động của Redis
function isRedisReady() {
  return redisConnected && redisClient && redisClient.status === 'ready';
}

module.exports = {
  redis: redisClient,
  isRedisReady
};
