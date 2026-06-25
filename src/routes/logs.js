const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

router.post('/client-error', (req, res) => {
  const { error, errorInfo, user, url, userAgent } = req.body;
  
  const logMessage = `
[${new Date().toISOString()}] CLIENT ERROR
URL: ${url || 'N/A'}
User Agent: ${userAgent || 'N/A'}
User: ${user ? JSON.stringify(user) : 'Guest'}
Error: ${error || 'N/A'}
Component Stack: ${errorInfo?.componentStack || 'N/A'}
--------------------------------------------------
`;

  // Ghi log ra console của server
  console.error(logMessage);

  // Ghi log vào file logs/client-errors.log
  const logDir = path.join(__dirname, '../../logs');
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    fs.appendFile(path.join(logDir, 'client-errors.log'), logMessage, (err) => {
      if (err) {
        console.error('Lỗi khi ghi log lỗi client vào file:', err);
      }
    });
  } catch (e) {
    console.error('Không thể khởi tạo thư mục logs:', e);
  }

  res.status(200).json({ success: true });
});

module.exports = router;
