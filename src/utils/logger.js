const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '../../logs');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB mỗi file log để bảo vệ SSD Mini Server

// Đảm bảo thư mục logs tồn tại
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const combinedLogPath = path.join(logDir, 'combined.log');
const errorLogPath = path.join(logDir, 'error.log');

function rotateIfNeeded(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.size >= MAX_LOG_SIZE) {
        fs.renameSync(filePath, `${filePath}.old`);
        return true;
      }
    }
  } catch (e) {}
  return false;
}

rotateIfNeeded(combinedLogPath);
rotateIfNeeded(errorLogPath);

// Tạo write streams để ghi log hiệu năng cao vào file
let combinedLogStream = fs.createWriteStream(combinedLogPath, { flags: 'a' });
let errorLogStream = fs.createWriteStream(errorLogPath, { flags: 'a' });
let writeCounter = 0;

function checkStreamRotation() {
  writeCounter += 1;
  if (writeCounter % 500 !== 0) return;

  if (rotateIfNeeded(combinedLogPath)) {
    try { combinedLogStream.end(); } catch (e) {}
    combinedLogStream = fs.createWriteStream(combinedLogPath, { flags: 'a' });
  }
  if (rotateIfNeeded(errorLogPath)) {
    try { errorLogStream.end(); } catch (e) {}
    errorLogStream = fs.createWriteStream(errorLogPath, { flags: 'a' });
  }
}

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
  checkStreamRotation();
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
