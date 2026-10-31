const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024; // Giới hạn file log 5MB, tự động xoay vòng khi đầy

function sanitizeField(val, maxLen = 500) {
  if (!val) return 'N/A';
  const str = typeof val === 'string' ? val : JSON.stringify(val);
  return str.slice(0, maxLen);
}

router.post('/client-error', (req, res) => {
  const { error, errorInfo, user, url, userAgent } = req.body || {};

  const safeUrl = sanitizeField(url, 300);
  const safeUa = sanitizeField(userAgent, 300);
  const safeUser = user ? sanitizeField({ id: user.id, username: user.username }, 200) : 'Guest';
  const safeError = sanitizeField(error, 1000);
  const safeStack = sanitizeField(errorInfo?.componentStack, 1500);

  const logMessage = [
    `[${new Date().toISOString()}] CLIENT ERROR`,
    `URL: ${safeUrl}`,
    `User Agent: ${safeUa}`,
    `User: ${safeUser}`,
    `Error: ${safeError}`,
    `Component Stack: ${safeStack}`,
    '--------------------------------------------------',
    ''
  ].join('\n');

  console.error(logMessage);

  const logDir = path.join(__dirname, '../../logs');
  const logFile = path.join(logDir, 'client-errors.log');

  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Xoay vòng file log nếu vượt quá 5MB để bảo vệ ổ cứng SSD
    if (fs.existsSync(logFile)) {
      const stat = fs.statSync(logFile);
      if (stat.size > MAX_LOG_FILE_BYTES) {
        fs.renameSync(logFile, path.join(logDir, 'client-errors.old.log'));
      }
    }

    fs.appendFile(logFile, logMessage, (err) => {
      if (err) {
        console.error('Lỗi khi ghi log lỗi client vào file:', err);
      }
    });
  } catch (e) {
    console.error('Không thể ghi thư mục logs:', e);
  }

  res.status(200).json({ success: true });
});

module.exports = router;
