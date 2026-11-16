const { verifyUserToken } = require('../utils/session');
const { contextStore } = require('../utils/context');

async function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return res.status(401).json({ error: 'Không tìm thấy token xác thực' });
  }

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    return res.status(401).json({ error: 'Token không hợp lệ' });
  }

  let session;
  try {
    session = await verifyUserToken(token);
  } catch (error) {
    const revoked = error && error.message === 'TOKEN_REVOKED';
    return res.status(401).json({
      error: revoked
        ? 'Mật khẩu tài khoản đã được thay đổi. Vui lòng đăng nhập lại.'
        : 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ',
      code: revoked ? 'SESSION_REVOKED' : 'SESSION_INVALID'
    });
  }

  req.userId = session.userId;
  req.tokenVersion = session.tokenVersion;
  contextStore.run({ userId: session.userId }, () => {
    next();
  });
}

module.exports = verifyToken;
