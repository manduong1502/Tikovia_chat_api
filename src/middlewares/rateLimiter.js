const jwt = require('jsonwebtoken');
const { redis, isRedisReady } = require('../utils/redis');
const { JWT_SECRET } = require('../config');

/**
 * Lấy IP thật của người dùng một cách an toàn:
 * - Ưu tiên CF-Connecting-IP (Cloudflare Tunnel luôn ghi đè, người dùng không thể giả mạo)
 * - Sau đó dùng req.ip (Express đã cấu hình trust proxy = 1, lấy hop cuối cùng do proxy thêm vào)
 * - Tuyệt đối KHÔNG lấy phần tử đầu tiên của X-Forwarded-For vì kẻ tấn công tự đặt được giá trị này để né Rate Limit
 */
function getClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp && typeof cfIp === 'string' && cfIp.length <= 64) {
    return cfIp.trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Xác định bucket theo userId đã được XÁC THỰC chữ ký JWT (không dùng đuôi token thô vì kẻ gian có thể
 * gửi token rác ngẫu nhiên để liên tục tạo bucket mới né giới hạn)
 */
function getVerifiedUserKey(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return 'anon';
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    return decoded?.userId ? `u:${decoded.userId}` : 'anon';
  } catch (e) {
    return 'anon';
  }
}

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
  }, windowMs * 2).unref();

  return async (req, res, next) => {
    let clientIdentifier;
    if (typeof options.keyGenerator === 'function') {
      clientIdentifier = options.keyGenerator(req);
      // Bỏ qua bộ giới hạn nếu không xác định được khoá (ví dụ: thiếu username)
      if (!clientIdentifier) return next();
    } else {
      const ip = getClientIp(req);
      if (options.byIpOnly) {
        clientIdentifier = ip;
      } else {
        // Người dùng đã đăng nhập: giới hạn theo tài khoản (công ty dùng chung Wi-Fi không bị khoá chéo)
        // Khách chưa đăng nhập / token giả: giới hạn theo IP
        const userKey = getVerifiedUserKey(req);
        clientIdentifier = userKey === 'anon' ? `ip:${ip}` : userKey;
      }
    }
    
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

// Chống dò mật khẩu phân tán (nhiều IP cùng tấn công 1 tài khoản): Tối đa 10 lần đăng nhập / 15 phút cho mỗi tài khoản
const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyPrefix: 'auth-account',
  keyGenerator: (req) => {
    const username = req.body?.username;
    if (!username || typeof username !== 'string') return null;
    return `acc:${username.trim().toLowerCase().slice(0, 50)}`;
  },
  message: 'Tài khoản này đã đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.'
});

// Route ghi log lỗi từ Client: Tách riêng bucket để không bao giờ ảnh hưởng đến việc đăng nhập
const logLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 15,
  byIpOnly: true,
  keyPrefix: 'client-logs',
  message: 'Quá nhiều báo cáo lỗi từ thiết bị này.'
});

module.exports = {
  authLimiter,
  loginAccountLimiter,
  messageLimiter,
  logLimiter,
  getClientIp
};
