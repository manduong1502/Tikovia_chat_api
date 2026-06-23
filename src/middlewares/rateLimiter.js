const { redis, isRedisReady } = require('../utils/redis');

// Custom high-performance distributed rate limiter middleware with Redis (and in-memory fallback)
const rateLimit = (options) => {
  const windowMs = options.windowMs || 60 * 1000;
  const max = options.max || 60;
  const message = options.message || 'Quá nhiều yêu cầu, vui lòng thử lại sau.';
  
  // In-memory fallback map
  const hits = new Map();

  // Định kỳ dọn dẹp các IP đã hết hạn của bộ nhớ đệm in-memory
  setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of hits.entries()) {
      if (now > data.resetTime) {
        hits.delete(ip);
      }
    }
  }, windowMs * 2);

  return async (req, res, next) => {
    // Lấy IP của client đằng sau proxy/reverse proxy
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    
    // Nếu Redis hoạt động, sử dụng Redis
    if (isRedisReady()) {
      try {
        const routeKey = req.baseUrl || req.path;
        const redisKey = `ratelimit:${ip}:${routeKey}`;
        
        const currentCount = await redis.incr(redisKey);
        
        if (currentCount === 1) {
          // Đặt thời gian hết hạn cho key theo mili giây
          await redis.pexpire(redisKey, windowMs);
        }
        
        if (currentCount > max) {
          return res.status(429).json({ error: message });
        }
        
        return next();
      } catch (error) {
        console.error('[Rate Limiter] Redis gặp lỗi, tự động fallback sang In-Memory:', error);
        // Fallback xuống logic in-memory bên dưới
      }
    }

    // Logic dự phòng (Fallback): In-Memory Rate Limiting
    const now = Date.now();

    if (!hits.has(ip)) {
      hits.set(ip, {
        count: 1,
        resetTime: now + windowMs
      });
      return next();
    }

    const clientData = hits.get(ip);

    if (now > clientData.resetTime) {
      clientData.count = 1;
      clientData.resetTime = now + windowMs;
      return next();
    }

    clientData.count++;
    
    if (clientData.count > max) {
      return res.status(429).json({ error: message });
    }

    next();
  };
};

// Route Đăng nhập/Đăng ký: Tối đa 15 yêu cầu trong 5 phút
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, 
  max: 15,
  message: 'Bạn đã thực hiện quá nhiều yêu cầu đăng nhập/đăng ký. Vui lòng thử lại sau 5 phút.'
});

// Route gửi tin nhắn/tải tệp: Tối đa 60 yêu cầu trong 1 phút
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Tần suất gửi tin nhắn hoặc tải tệp quá nhanh. Vui lòng thử lại sau 1 phút.'
});

module.exports = {
  authLimiter,
  messageLimiter
};
