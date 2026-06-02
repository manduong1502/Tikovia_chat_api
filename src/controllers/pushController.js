const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const prisma = require('../db');

const vapidKeysPath = path.join(__dirname, '../../vapid.json');
let vapidKeys;

// Tải hoặc sinh tự động khoá VAPID
if (fs.existsSync(vapidKeysPath)) {
  try {
    vapidKeys = JSON.parse(fs.readFileSync(vapidKeysPath, 'utf8'));
  } catch (e) {
    console.error('Lỗi đọc file vapid.json, sẽ tạo lại:', e);
  }
}

if (!vapidKeys) {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(vapidKeysPath, JSON.stringify(vapidKeys, null, 2), 'utf8');
  console.log('=== KHOÁ VAPID MỚI ĐÃ ĐƯỢC TẠO VÀ LƯU VÀO VAPID.JSON ===');
}

// Thiết lập cấu hình web-push
webpush.setVapidDetails(
  'mailto:support@chattikovia.local',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// API gửi khoá công khai
const getPublicKey = (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
};

// API đăng ký thiết bị nhận thông báo đẩy
const subscribe = async (req, res) => {
  const userId = req.user.id;
  const { subscription, data } = req.body;

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

    // Lưu hoặc cập nhật subscription
    const saved = await prisma.pushSubscription.upsert({
      where: { endpoint: finalSubscription.endpoint },
      update: {
        userId,
        keysP256dh,
        keysAuth
      },
      create: {
        userId,
        endpoint: finalSubscription.endpoint,
        keysP256dh,
        keysAuth
      }
    });

    res.json({ success: true, saved });
  } catch (error) {
    console.error('Lỗi lưu đăng ký thông báo đẩy:', error);
    res.status(500).json({ error: 'Lỗi máy chủ khi đăng ký thông báo' });
  }
};

// Helper để gửi thông báo cho một người dùng
const sendNotificationHelper = async (userId, payload) => {
  try {
    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId }
    });

    if (subscriptions.length === 0) return;

    const payloadString = JSON.stringify(payload);

    const promises = subscriptions.map(sub => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.keysP256dh,
          auth: sub.keysAuth
        }
      };

      return webpush.sendNotification(pushSubscription, payloadString)
        .catch(async (err) => {
          // Nếu subscription không còn hiệu lực (410 Gone hoặc 404), xóa khỏi DB
          if (err.statusCode === 410 || err.statusCode === 404) {
            console.log(`Xoá subscription đã hết hạn cho user ${userId}:`, sub.endpoint);
            await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
          } else {
            console.error(`Lỗi gửi push notification cho endpoint ${sub.endpoint}:`, err);
          }
        });
    });

    await Promise.all(promises);
  } catch (error) {
    console.error(`Lỗi khi chạy helper gửi thông báo đẩy cho user ${userId}:`, error);
  }
};

module.exports = {
  getPublicKey,
  subscribe,
  sendNotificationHelper
};
