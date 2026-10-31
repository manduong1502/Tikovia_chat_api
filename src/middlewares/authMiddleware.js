const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');

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
    
    const { contextStore } = require('../utils/context');
    contextStore.run({ userId: decoded.userId }, () => {
      next();
    });
  } catch (error) {
    return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ' });
  }
}

module.exports = verifyToken;
