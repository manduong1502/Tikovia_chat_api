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

// 1. Ưu tiên đọc từ biến môi trường (.env)
if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
  vapidKeys = {
    publicKey: config.VAPID_PUBLIC_KEY,
    privateKey: config.VAPID_PRIVATE_KEY
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
  logger.info(`=== KHOÁ VAPID MỚI ĐÃ ĐƯỢC TẠO ===`);
}

// Đảm bảo lưu bản sao khoá VAPID vào ổ cứng SSD (/app/uploads/.vapid.json) để không bao giờ mất khi rebuild Docker
try {
  fs.writeFileSync(persistentVapidPath, JSON.stringify(vapidKeys, null, 2), 'utf8');
} catch (e) {
  logger.warn('Không thể ghi file .vapid.json vào thư mục uploads:', e.message);
}

// Thiết lập cấu hình web-push với email hợp lệ cho Apple APNs và Google FCM
webpush.setVapidDetails(
  config.VAPID_SUBJECT || 'mailto:admin@tikovia.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

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

/**
 * Chuẩn hoá đường dẫn Icon cho thông báo đẩy di động (Android FCM / iOS APNs chỉ hỗ trợ PNG/JPG/WebP, không hỗ trợ SVG)
 */
const PUBLIC_API_ORIGIN = (process.env.PUBLIC_API_URL || 'https://api-chat.tikovia.vn').replace(/\/api\/?$/, '');

function normalizeNotificationIcon(icon) {
  if (!icon || typeof icon !== 'string') return '/pwa-192x192.png';
  if (icon.includes('dicebear.com') || icon.toLowerCase().endsWith('.svg')) {
    return '/pwa-192x192.png';
  }
  if (icon.startsWith('/api/uploads/')) {
    return `${PUBLIC_API_ORIGIN}${icon}`;
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
    if (!userId) return { sent: 0, total: 0 };

    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId }
    });

    if (subscriptions.length === 0) {
      return { sent: 0, total: 0 };
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
          // Nếu subscription không còn hiệu lực (410 Gone, 404 Not Found, 401/403 VAPID mismatch), xóa khỏi DB
          if ([401, 403, 404, 410].includes(err.statusCode)) {
            logger.info(`[Push] Xoá subscription hết hạn/lỗi (${err.statusCode}) của user ${userId}`);
            await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
          } else {
            logger.error(`[Push] Lỗi gửi push tới user ${userId}:`, err.message || err);
          }
        });
    });

    await Promise.all(promises);
    return { sent: sentCount, total: subscriptions.length };
  } catch (error) {
    logger.error(`Lỗi khi chạy sendNotificationHelper cho user ${userId}:`, error);
    return { sent: 0, total: 0 };
  }
};

// API kiểm tra gửi thông báo thử nghiệm về điện thoại của người dùng hiện tại
const testPushNotification = async (req, res) => {
  try {
    const userId = req.userId;
    const result = await sendNotificationHelper(userId, {
      title: '🔔 Kiểm tra thông báo ChatTikovia',
      body: 'Thiết bị của bạn đã kết nối thông báo đẩy thành công!',
      icon: '/pwa-192x192.png',
      tag: 'device-test',
      data: {
        url: '/',
        type: 'test'
      }
    });

    if (result.total === 0) {
      return res.status(404).json({
        error: 'Chưa có thiết bị nào đăng ký nhận thông báo cho tài khoản này. Vui lòng bật quyền thông báo trên trình duyệt.'
      });
    }

    return res.json({
      message: `Đã gửi thông báo thử tới ${result.sent}/${result.total} thiết bị đã đăng ký.`,
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
  sendNotificationHelper,
  testPushNotification
};
