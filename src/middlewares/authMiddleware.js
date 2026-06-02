const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'chattikovia_super_secret_key_12345';

function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  
  if (!authHeader) {
    return res.status(401).json({ error: 'Không tìm thấy token xác thực' });
  }

  const token = authHeader.split(' ')[1]; // Định dạng "Bearer TOKEN"
  
  if (!token) {
    return res.status(401).json({ error: 'Token không hợp lệ' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(403).json({ error: 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ' });
  }
}

module.exports = verifyToken;
