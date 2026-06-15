// Custom high-performance in-memory rate limiter middleware
const rateLimit = (options) => {
  const windowMs = options.windowMs || 60 * 1000;
  const max = options.max || 60;
  const message = options.message || 'Quá nhiều yêu cầu, vui lòng thử lại sau.';
  
  const hits = new Map();

  // Định kỳ dọn dẹp các IP đã hết hạn để tránh leak bộ nhớ
  setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of hits.entries()) {
      if (now > data.resetTime) {
        hits.delete(ip);
      }
    }
  }, windowMs * 2);

  return (req, res, next) => {
    // Lấy IP của client đằng sau proxy/reverse proxy
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
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
