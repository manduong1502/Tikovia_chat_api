const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '../../logs');

// Đảm bảo thư mục logs tồn tại
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Tạo write streams để ghi log hiệu năng cao vào file
const combinedLogStream = fs.createWriteStream(path.join(logDir, 'combined.log'), { flags: 'a' });
const errorLogStream = fs.createWriteStream(path.join(logDir, 'error.log'), { flags: 'a' });

function formatLog(level, message, meta) {
  const timestamp = new Date().toISOString();
  
  let metaStr = '';
  if (meta) {
    if (meta instanceof Error) {
      metaStr = ` | Error: ${meta.message}\nStack: ${meta.stack}`;
    } else {
      try {
        metaStr = ` | Meta: ${JSON.stringify(meta)}`;
      } catch (e) {
        metaStr = ` | Meta: [Unserializable Object]`;
      }
    }
  }
  
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}\n`;
}

function writeLog(level, message, meta) {
  const logLine = formatLog(level, message, meta);
  
  // Xuất ra console tiêu chuẩn
  if (level === 'error') {
    console.error(logLine.trim());
    errorLogStream.write(logLine);
  } else if (level === 'warn') {
    console.warn(logLine.trim());
  } else {
    console.log(logLine.trim());
  }

  // Luôn ghi toàn bộ vào combined log
  combinedLogStream.write(logLine);
}

module.exports = {
  info: (msg, meta) => writeLog('info', msg, meta),
  warn: (msg, meta) => writeLog('warn', msg, meta),
  error: (msg, meta) => writeLog('error', msg, meta)
};
