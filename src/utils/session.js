const jwt = require('jsonwebtoken');
const prisma = require('../db');
const { JWT_SECRET } = require('../config');

/**
 * Quản lý phiên đăng nhập theo "tokenVersion":
 * - Mỗi JWT mang claim `tv` = tokenVersion của người dùng tại thời điểm cấp.
 * - Khi đổi mật khẩu, tokenVersion tăng lên → mọi token cũ trên các máy khác bị từ chối.
 * - Token phát hành trước bản cập nhật này không có `tv` → coi như 0 (không đăng xuất hàng loạt khi triển khai).
 *
 * Bộ nhớ đệm 30 giây giúp không phải truy vấn CSDL ở mỗi request / sự kiện socket.
 */
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // userId -> { version, expiresAt }

const TOKEN_EXPIRES_IN = '7d';

function signUserToken(userId, tokenVersion = 0) {
  return jwt.sign({ userId, tv: tokenVersion }, JWT_SECRET, { expiresIn: TOKEN_EXPIRES_IN });
}

async function getCurrentTokenVersion(userId) {
  const now = Date.now();
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > now) return cached.version;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tokenVersion: true }
  });
  if (!user) {
    cache.delete(userId);
    return null; // Tài khoản không còn tồn tại
  }
  const version = Number(user.tokenVersion) || 0;
  cache.set(userId, { version, expiresAt: now + CACHE_TTL_MS });
  if (cache.size > 5000) {
    for (const [key, val] of cache) {
      if (val.expiresAt <= now) cache.delete(key);
    }
  }
  return version;
}

/**
 * Xác thực chữ ký JWT + kiểm tra phiên còn hiệu lực. Trả về { userId, tokenVersion } hoặc ném lỗi.
 */
async function verifyUserToken(token) {
  const decoded = jwt.verify(token, JWT_SECRET);
  if (!decoded || !decoded.userId) {
    throw new Error('INVALID_TOKEN');
  }
  const tokenVersion = Number(decoded.tv) || 0;
  const currentVersion = await getCurrentTokenVersion(decoded.userId);
  if (currentVersion === null) {
    throw new Error('USER_NOT_FOUND');
  }
  if (tokenVersion !== currentVersion) {
    throw new Error('TOKEN_REVOKED');
  }
  return { userId: decoded.userId, tokenVersion };
}

function setCachedTokenVersion(userId, version) {
  cache.set(userId, { version, expiresAt: Date.now() + CACHE_TTL_MS });
}

module.exports = {
  signUserToken,
  verifyUserToken,
  getCurrentTokenVersion,
  setCachedTokenVersion
};
