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
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    // Phân tách bucket theo từng nhân viên (dựa trên đuôi JWT token) để toàn bộ công ty dùng chung 1 mạng Wi-Fi văn phòng không bị khóa chéo nhau
    const authHeader = req.headers['authorization'];
    const userTokenSuffix = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.slice(-16)
      : 'anon';
    const clientIdentifier = options.byIpOnly ? ip : `${ip}:${userTokenSuffix}`;
    
    // Nếu Redis hoạt động, sử dụng Redis
    if (isRedisReady()) {
      try {
        const routeKey = options.keyPrefix || req.baseUrl || req.path;
        const redisKey = `ratelimit:${routeKey}:${clientIdentifier}`;
        
        const currentCount = await redis.incr(redisKey);
        
        if (currentCount === 1) {
          // Đặt thời gian hết hạn cho key theo mili giây
          await redis.pexpire(redisKey, windowMs);
        } else if (currentCount % 10 === 0) {
          // Đảm bảo key không bao giờ bị kẹt vĩnh viễn (TTL = -1) nếu tiến trình gián đoạn giữa incr và pexpire
          const ttl = await redis.pttl(redisKey);
          if (ttl === -1) {
            await redis.pexpire(redisKey, windowMs);
          }
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

    if (!hits.has(clientIdentifier)) {
      hits.set(clientIdentifier, {
        count: 1,
        resetTime: now + windowMs
      });
      return next();
    }

    const clientData = hits.get(clientIdentifier);

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

// Route Đăng nhập/Đăng ký: Tối đa 20 yêu cầu trong 5 phút trên mỗi IP
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, 
  max: 20,
  byIpOnly: true,
  keyPrefix: 'auth-login',
  message: 'Bạn đã thực hiện quá nhiều yêu cầu đăng nhập/đăng ký. Vui lòng thử lại sau 5 phút.'
});

// Route API nghiệp vụ (tin nhắn, tìm kiếm, tải tệp): Tối đa 240 yêu cầu trong 1 phút trên mỗi tài khoản
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  keyPrefix: 'api-user',
  message: 'Tần suất thao tác quá nhanh. Vui lòng thử lại sau ít giây.'
});

module.exports = {
  authLimiter,
  messageLimiter
};
