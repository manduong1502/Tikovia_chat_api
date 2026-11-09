const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');
const prisma = require('../db');
const config = require('../config');
const { BASE_UPLOAD_DIR } = require('../utils/storage');
const logger = require('../utils/logger');

const legacyVapidPath = path.join(__dirname, '../../vapid.json');
const persistentVapidPath = path.join(BASE_UPLOAD_DIR, '.vapid.json');

let vapidKeys = null;

// 1. Ưu tiên đọc từ biến môi trường (.env) nếu hợp lệ (không phải chuỗi mẫu)
if (
  config.VAPID_PUBLIC_KEY &&
  config.VAPID_PRIVATE_KEY &&
  !config.VAPID_PUBLIC_KEY.includes('your_vapid') &&
  !config.VAPID_PRIVATE_KEY.includes('your_vapid')
) {
  vapidKeys = {
    publicKey: config.VAPID_PUBLIC_KEY.trim(),
    privateKey: config.VAPID_PRIVATE_KEY.trim()
  };
}

// 2. Nếu chưa có trong .env, kiểm tra trong volume SSD bền vững (/app/uploads/.vapid.json)
if (!vapidKeys && fs.existsSync(persistentVapidPath)) {
  try {
    vapidKeys = JSON.parse(fs.readFileSync(persistentVapidPath, 'utf8'));
  } catch (e) {
    logger.error('Lỗi đọc file .vapid.json trong uploads:', e);
  }
}

// 3. Fallback đọc từ file vapid.json gốc và sao lưu sang thư mục SSD bền vững
if (!vapidKeys && fs.existsSync(legacyVapidPath)) {
  try {
    vapidKeys = JSON.parse(fs.readFileSync(legacyVapidPath, 'utf8'));
  } catch (e) {
    logger.error('Lỗi đọc file vapid.json gốc:', e);
  }
}

// 4. Nếu hoàn toàn chưa có, sinh tự động khoá VAPID mới
if (!vapidKeys || !vapidKeys.publicKey || !vapidKeys.privateKey) {
  vapidKeys = webpush.generateVAPIDKeys();
  logger.info('=== KHOÁ VAPID MỚI ĐÃ ĐƯỢC TẠO ===');
}

// Thiết lập cấu hình web-push với email hợp lệ cho Apple APNs và Google FCM
let safeSubject = String(config.VAPID_SUBJECT || 'mailto:admin@tikovia.vn').trim();
if (!safeSubject.startsWith('mailto:') && !safeSubject.startsWith('https://')) {
  safeSubject = `mailto:${safeSubject}`;
}

try {
  webpush.setVapidDetails(safeSubject, vapidKeys.publicKey, vapidKeys.privateKey);
} catch (err) {
  logger.warn('Khoá VAPID cấu hình không hợp lệ, tự động sinh lại khoá VAPID mới:', err.message);
  vapidKeys = webpush.generateVAPIDKeys();
  webpush.setVapidDetails('mailto:admin@tikovia.vn', vapidKeys.publicKey, vapidKeys.privateKey);
}

// Đảm bảo lưu bản sao khoá VAPID vào ổ cứng SSD (/app/uploads/.vapid.json) để không bao giờ mất khi rebuild Docker
try {
  fs.writeFileSync(persistentVapidPath, JSON.stringify(vapidKeys, null, 2), 'utf8');
} catch (e) {
  logger.warn('Không thể ghi file .vapid.json vào thư mục uploads:', e.message);
}

// API gửi khoá công khai cho trình duyệt
const getPublicKey = (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
};

// API đăng ký thiết bị nhận thông báo đẩy
const subscribe = async (req, res) => {
  const userId = req.userId;
  const { subscription, data } = req.body;
  const userAgent = req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 500) : null;

  let finalSubscription = subscription;

  // Giải mã dữ liệu base64 nếu client gửi dạng obfuscated để vượt qua Cloudflare WAF
  if (data) {
    try {
      const decodedString = Buffer.from(data, 'base64').toString('utf8');
      finalSubscription = JSON.parse(decodedString);
    } catch (err) {
      return res.status(400).json({ error: 'Dữ liệu mã hoá không hợp lệ' });
    }
  }

  if (!finalSubscription || !finalSubscription.endpoint) {
    return res.status(400).json({ error: 'Dữ liệu đăng ký không hợp lệ' });
  }

  try {
    const keysP256dh = finalSubscription.keys?.p256dh || '';
    const keysAuth = finalSubscription.keys?.auth || '';

    if (!keysP256dh || !keysAuth) {
      return res.status(400).json({ error: 'Thiếu khoá mã hoá p256dh hoặc auth' });
    }

    const saved = await prisma.pushSubscription.upsert({
      where: { endpoint: finalSubscription.endpoint },
      update: {
        userId,
        keysP256dh,
        keysAuth,
        userAgent
      },
      create: {
        userId,
        endpoint: finalSubscription.endpoint,
        keysP256dh,
        keysAuth,
        userAgent
      }
    });

    res.json({ success: true, saved });
  } catch (error) {
    logger.error('Lỗi lưu đăng ký thông báo đẩy:', error);
    res.status(500).json({ error: 'Lỗi máy chủ khi đăng ký thông báo' });
  }
};

// API huỷ đăng ký thiết bị khi người dùng đăng xuất (Tránh nhận nhầm thông báo của tài khoản cũ trên cùng điện thoại)
const unsubscribe = async (req, res) => {
  const { endpoint, data } = req.body || {};
  let targetEndpoint = endpoint;

  if (data && !targetEndpoint) {
    try {
      const decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
      targetEndpoint = decoded?.endpoint;
    } catch (e) {}
  }

  try {
    if (targetEndpoint) {
      await prisma.pushSubscription.deleteMany({
        where: { endpoint: String(targetEndpoint) }
      });
    }
    return res.json({ success: true });
  } catch (error) {
    logger.error('Lỗi xoá đăng ký thông báo đẩy khi đăng xuất:', error);
    return res.json({ success: true });
  }
};

/**
 * Chuẩn hoá đường dẫn Icon cho thông báo đẩy di động (Android FCM / iOS APNs chỉ hỗ trợ PNG/JPG/WebP qua HTTPS, không hỗ trợ SVG hoặc localhost)
 */
const PUBLIC_API_ORIGIN = (process.env.PUBLIC_API_URL || 'https://api-chat.tikovia.vn').replace(/\/api\/?$/, '');

function normalizeNotificationIcon(icon) {
  if (!icon || typeof icon !== 'string') return '/pwa-192x192.png';
  if (icon.includes('dicebear.com') || icon.toLowerCase().endsWith('.svg')) {
    return '/pwa-192x192.png';
  }
  const uploadsIdx = icon.indexOf('/api/uploads/');
  if (uploadsIdx !== -1) {
    return `${PUBLIC_API_ORIGIN}${icon.slice(uploadsIdx)}`;
  }
  if (icon.startsWith('http://localhost') || icon.startsWith('http://127.0.0.1') || icon.startsWith('http://192.168.')) {
    return '/pwa-192x192.png';
  }
  return icon;
}

/**
 * Chuẩn hoá Topic Header theo RFC 8030 (tối đa 32 ký tự URL-safe base64) cho Apple APNs & Google FCM
 */
function buildSafeWebPushTopic(rawTopic) {
  if (!rawTopic) return undefined;
  const cleaned = String(rawTopic).replace(/[^A-Za-z0-9\-_]/g, '');
  if (cleaned.length > 0 && cleaned.length <= 32) {
    return cleaned;
  }
  return crypto.createHash('sha256').update(String(rawTopic)).digest('base64url').slice(0, 32);
}

/**
 * Helper gửi thông báo đẩy Web Push chuẩn Production tới mọi thiết bị của một người dùng.
 * Tối ưu độ ưu tiên cao (urgency: 'high') để đánh thức màn hình khóa iOS (APNs) & Android Doze Mode (FCM).
 */
const sendNotificationHelper = async (userId, payload, customOptions = {}) => {
  try {
    if (!userId) return { sent: 0, total: 0, errors: [] };

    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId }
    });

    if (subscriptions.length === 0) {
      return { sent: 0, total: 0, errors: [] };
    }

    const enrichedPayload = {
      timestamp: Date.now(),
      ...payload,
      icon: normalizeNotificationIcon(payload?.icon)
    };
    const payloadString = JSON.stringify(enrichedPayload);

    const isEphemeralCall = Boolean(enrichedPayload.isCall || enrichedPayload.type === 'call-ended');
    const ttl = customOptions.TTL !== undefined ? customOptions.TTL : (isEphemeralCall ? 60 : 86400);
    const urgency = customOptions.urgency || 'high';
    const topic = customOptions.topic ? buildSafeWebPushTopic(customOptions.topic) : undefined;

    const pushOptions = {
      TTL: ttl,
      urgency
    };
    if (topic) {
      pushOptions.topic = topic;
    }

    let sentCount = 0;
    const errors = [];

    const promises = subscriptions.map((sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.keysP256dh,
          auth: sub.keysAuth
        }
      };

      return webpush
        .sendNotification(pushSubscription, payloadString, pushOptions)
        .then(() => {
          sentCount += 1;
        })
        .catch(async (err) => {
          const status = err.statusCode || 0;
          const detail = err.body ? String(err.body).slice(0, 200) : err.message || 'Unknown error';
          errors.push(`HTTP ${status}: ${detail}`);

          // Nếu subscription không còn hiệu lực (400 Bad Request/VapidPkHashMismatch, 401/403 VAPID mismatch, 404 Not Found, 410 Gone), xóa khỏi DB
          if ([400, 401, 403, 404, 410].includes(status)) {
            logger.info(`[Push] Xoá subscription hết hạn/lỗi (${status}) của user ${userId}: ${detail}`);
            await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
          } else {
            logger.error(`[Push] Lỗi gửi push tới user ${userId} (${status}): ${detail}`);
          }
        });
    });

    await Promise.all(promises);
    return { sent: sentCount, total: subscriptions.length, errors };
  } catch (error) {
    logger.error(`Lỗi khi chạy sendNotificationHelper cho user ${userId}:`, error);
    return { sent: 0, total: 0, errors: [error.message] };
  }
};

// API kiểm tra gửi thông báo thử nghiệm về điện thoại của người dùng hiện tại
const testPushNotification = async (req, res) => {
  try {
    const userId = req.userId;
    const result = await sendNotificationHelper(userId, {
      title: '🔔 Kiểm tra thông báo ChatTikovia',
      body: 'Thiết bị của bạn đã kết nối thông báo đẩy và chuông báo thành công!',
      icon: '/pwa-192x192.png',
      tag: 'device-test',
      data: {
        url: '/',
        type: 'test'
      }
    });

    if (result.total === 0) {
      return res.status(404).json({
        error: 'Chưa có thiết bị nào đăng ký nhận thông báo cho tài khoản này. Vui lòng bấm "Đồng bộ lại" để cấp token mới.'
      });
    }

    if (result.sent === 0) {
      return res.status(400).json({
        error: `Token cũ trên thiết bị đã hết hạn hoặc lệch khoá (${result.errors?.[0] || 'APNs/FCM rejected'}). Đang tự động cấp lại token mới...`,
        ...result
      });
    }

    return res.json({
      message: `🔔 Đã gửi thông báo thử thành công tới ${result.sent}/${result.total} thiết bị!`,
      ...result
    });
  } catch (error) {
    logger.error('Lỗi gửi thông báo thử nghiệm:', error);
    return res.status(500).json({ error: 'Lỗi máy chủ khi gửi thông báo thử nghiệm' });
  }
};

module.exports = {
  getPublicKey,
  subscribe,
  unsubscribe,
  sendNotificationHelper,
  testPushNotification
};
