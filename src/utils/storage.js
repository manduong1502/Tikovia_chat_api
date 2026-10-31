const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');
const logger = require('./logger');

// Đường dẫn tuyệt đối tới thư mục lưu trữ trên ổ cứng SSD của Ubuntu Mini Server
const BASE_UPLOAD_DIR = path.resolve(config.UPLOAD_DIR || './uploads');

// Đảm bảo thư mục gốc tồn tại
if (!fs.existsSync(BASE_UPLOAD_DIR)) {
  fs.mkdirSync(BASE_UPLOAD_DIR, { recursive: true });
}

// Danh sách các định dạng tệp bị cấm vì lý do an toàn bảo mật (chống XSS, RCE và malware)
const BLOCKED_EXTENSIONS = new Set([
  '.html', '.htm', '.xhtml', '.shtml',
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
  '.svg', '.svgz', // Ngăn Stored XSS qua SVG chứa script
  '.php', '.php3', '.php4', '.php5', '.phtml', '.phar',
  '.asp', '.aspx', '.jsp', '.jspx', '.pl', '.py', '.rb', '.cgi',
  '.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1', '.exe', '.com', '.msi', '.dll', '.scr', '.vbs', '.wsf', '.lnk', '.hta', '.jar'
]);

const BLOCKED_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
  'application/x-httpd-php',
  'application/x-sh',
  'application/x-msdownload',
  'application/x-msdos-program'
]);

// Bản đồ MIME sang đuôi file mặc định cho các tệp ghi âm/ảnh từ thiết bị di động (iOS/Android) đôi khi thiếu đuôi mở rộng
const MIME_FALLBACK_EXT = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

/**
 * Khắc phục lỗi Multer/Busboy giải mã tên file tiếng Việt theo chuẩn latin1
 * và loại bỏ các ký tự điều khiển nguy hiểm.
 */
function decodeOriginalFilename(rawName = 'file') {
  let decoded = rawName;
  try {
    // Nếu chuỗi chứa các byte cao latin1 (0x80 - 0xFF) nhưng không có ký tự Unicode > 0xFF
    if (/[\u0080-\u00ff]/.test(rawName) && !/[\u0100-\uffff]/.test(rawName)) {
      const candidate = Buffer.from(rawName, 'latin1').toString('utf8');
      if (!candidate.includes('\uFFFD')) {
        decoded = candidate;
      }
    }
  } catch (e) {
    decoded = rawName;
  }
  // Loại bỏ ký tự phân cách đường dẫn và ký tự điều khiển
  return path.basename(decoded).replace(/[\x00-\x1f\x80-\x9f]/g, '').trim() || 'file';
}

/**
 * Xác định thư mục con theo loại tệp và tháng (YYYY-MM) để tối ưu hiệu năng đọc/ghi IOPS trên SSD
 */
function resolveCategorySubdir(req, file) {
  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const mime = (file.mimetype || '').toLowerCase();
  const originalName = (file.originalname || '').toLowerCase();

  if (req.query?.type === 'avatar' || req.body?.type === 'avatar') {
    return 'avatars';
  }
  if (mime.startsWith('audio/') || originalName.startsWith('voice-message')) {
    return path.join('voice', yearMonth);
  }
  if (mime.startsWith('image/')) {
    return path.join('images', yearMonth);
  }
  return path.join('files', yearMonth);
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    try {
      const subDir = resolveCategorySubdir(req, file);
      const targetDir = path.join(BASE_UPLOAD_DIR, subDir);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      req._uploadSubDir = subDir.replace(/\\/g, '/');
      cb(null, targetDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: function (req, file, cb) {
    const cleanOriginal = decodeOriginalFilename(file.originalname);
    file.decodedOriginalName = cleanOriginal;

    const baseMime = (file.mimetype || '').split(';')[0].trim().toLowerCase();
    let ext = path.extname(cleanOriginal).toLowerCase();
    if (!ext && MIME_FALLBACK_EXT[baseMime]) {
      ext = MIME_FALLBACK_EXT[baseMime];
    }

    const uniqueId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    cb(null, `${uniqueId}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const cleanOriginal = decodeOriginalFilename(file.originalname);
  const baseMime = (file.mimetype || '').split(';')[0].trim().toLowerCase();
  let ext = path.extname(cleanOriginal).toLowerCase();

  if (!ext && MIME_FALLBACK_EXT[baseMime]) {
    ext = MIME_FALLBACK_EXT[baseMime];
  }

  if (!ext || BLOCKED_EXTENSIONS.has(ext) || BLOCKED_MIME_TYPES.has(baseMime)) {
    return cb(new Error('Định dạng tệp tin không được phép tải lên vì lý do bảo mật.'));
  }

  cb(null, true);
};

const maxFileSizeBytes = (config.MAX_FILE_SIZE_MB || 50) * 1024 * 1024;

const uploadMiddleware = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: maxFileSizeBytes,
    files: 1
  }
});

/**
 * Xóa tệp vật lý trên ổ cứng SSD khi tin nhắn bị thu hồi (Recall) hoặc thay ảnh đại diện,
 * có kiểm tra chống Path Traversal tuyệt đối.
 */
async function deleteLocalFile(fileUrl) {
  if (!fileUrl || typeof fileUrl !== 'string') return false;
  if (!fileUrl.startsWith('/api/uploads/')) return false;

  try {
    const relativePart = decodeURIComponent(fileUrl.replace(/^\/api\/uploads\//, ''));
    if (!relativePart || relativePart.startsWith('.')) return false;

    const resolvedPath = path.resolve(BASE_UPLOAD_DIR, relativePart);
    // Đảm bảo đường dẫn giải quyết nằm bên trong BASE_UPLOAD_DIR
    if (!resolvedPath.startsWith(BASE_UPLOAD_DIR + path.sep)) {
      logger.warn(`[Storage] Phát hiện đường dẫn không hợp lệ khi xóa file: ${fileUrl}`);
      return false;
    }

    if (fs.existsSync(resolvedPath)) {
      await fs.promises.unlink(resolvedPath);
      logger.info(`[Storage] Đã xóa tệp trên SSD: ${relativePart}`);
      return true;
    }
  } catch (err) {
    logger.error(`[Storage] Lỗi khi xóa tệp cục bộ (${fileUrl}):`, err);
  }
  return false;
}

module.exports = {
  BASE_UPLOAD_DIR,
  uploadMiddleware,
  decodeOriginalFilename,
  deleteLocalFile
};
