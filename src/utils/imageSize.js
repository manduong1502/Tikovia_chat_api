const fs = require('fs');
const path = require('path');

/**
 * Đọc kích thước (rộng × cao) của ảnh JPEG / PNG / GIF / WebP chỉ từ phần đầu tệp, không cần thư viện ngoài.
 * Ảnh JPEG chụp từ điện thoại có thể bị xoay bằng thẻ EXIF Orientation → trả về kích thước SAU khi xoay
 * (đúng như trình duyệt hiển thị), để giao diện chừa sẵn đúng khung ảnh.
 */

const MAX_DIMENSION = 20000;

function valid(width, height) {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_DIMENSION &&
    height <= MAX_DIMENSION
  );
}

function parsePng(buf) {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function parseGif(buf) {
  if (buf.length < 10 || buf.toString('ascii', 0, 4) !== 'GIF8') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function parseWebp(buf) {
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const b0 = buf[21];
    const b1 = buf[22];
    const b2 = buf[23];
    const b3 = buf[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    };
  }
  if (chunk === 'VP8X') {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  return null;
}

function readExifOrientation(buf, start, length) {
  // start trỏ tới đầu dữ liệu APP1 (sau 2 byte độ dài)
  if (length < 14 || buf.toString('ascii', start, start + 4) !== 'Exif') return 1;
  const tiff = start + 6;
  if (tiff + 8 > buf.length) return 1;
  const byteOrder = buf.toString('ascii', tiff, tiff + 2);
  const little = byteOrder === 'II';
  if (!little && byteOrder !== 'MM') return 1;
  const u16 = (o) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > buf.length) return 1;
  const entries = u16(ifd0);
  for (let i = 0; i < entries; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > buf.length) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function parseJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  let orientation = 1;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Các marker không có độ dài
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // Kết thúc ảnh / bắt đầu dữ liệu nén: không còn header
    const segmentLength = buf.readUInt16BE(offset + 2);
    if (segmentLength < 2) break;
    const dataStart = offset + 4;

    if (marker === 0xe1) {
      orientation = readExifOrientation(buf, dataStart, segmentLength - 2);
    }

    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (dataStart + 5 > buf.length) return null;
      const height = buf.readUInt16BE(dataStart + 1);
      const width = buf.readUInt16BE(dataStart + 3);
      // Orientation 5–8: ảnh xoay 90° → hoán đổi rộng/cao
      return orientation >= 5 ? { width: height, height: width } : { width, height };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function getImageSizeFromBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return null;
  const result = parsePng(buf) || parseGif(buf) || parseWebp(buf) || parseJpeg(buf);
  if (!result || !valid(result.width, result.height)) return null;
  return result;
}

/**
 * Đọc kích thước ảnh từ đường dẫn tin nhắn dạng /api/uploads/images/YYYY-MM/<tệp> (chỉ đọc tối đa 256KB đầu tệp).
 * Trả về null nếu không đọc được — không bao giờ ném lỗi để không làm hỏng việc gửi tin nhắn.
 */
async function getLocalImageSize(fileUrl, baseUploadDir) {
  try {
    if (typeof fileUrl !== 'string' || !fileUrl.startsWith('/api/uploads/images/')) return null;
    const relative = decodeURIComponent(fileUrl.slice('/api/uploads/'.length));
    if (!relative || relative.includes('..') || relative.split(/[\\/]/).some((seg) => seg.startsWith('.'))) {
      return null;
    }
    const resolved = path.resolve(baseUploadDir, relative);
    if (!resolved.startsWith(path.resolve(baseUploadDir) + path.sep)) return null;

    const handle = await fs.promises.open(resolved, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, 0);
      return getImageSizeFromBuffer(buf);
    } finally {
      await handle.close();
    }
  } catch (e) {
    return null;
  }
}

// Bộ nhớ đệm kích thước ảnh (đường dẫn → {width,height} hoặc null) để không đọc lại tệp mỗi lần tải lịch sử
const sizeCache = new Map();
const SIZE_CACHE_LIMIT = 5000;

async function getLocalImageSizeCached(fileUrl, baseUploadDir) {
  if (sizeCache.has(fileUrl)) return sizeCache.get(fileUrl);
  const dims = await getLocalImageSize(fileUrl, baseUploadDir);
  if (sizeCache.size >= SIZE_CACHE_LIMIT) {
    sizeCache.delete(sizeCache.keys().next().value);
  }
  sizeCache.set(fileUrl, dims);
  return dims;
}

/**
 * Gắn kích thước vào metadata của các tin nhắn ảnh cũ (gửi trước khi có tính năng này) khi trả lịch sử cho client.
 * Chỉ thay đổi dữ liệu trả về, KHÔNG ghi vào CSDL.
 */
async function enrichImageMessagesWithSize(messages, baseUploadDir) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  await Promise.all(
    messages.map(async (msg) => {
      if (!msg || msg.type !== 'image' || msg.isRecalled || typeof msg.content !== 'string') return;
      let meta = {};
      if (msg.metadata) {
        try {
          meta = JSON.parse(msg.metadata);
        } catch (e) {
          return;
        }
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return;
        if (meta.width && meta.height) return;
      }
      const dims = await getLocalImageSizeCached(msg.content, baseUploadDir);
      if (dims) {
        msg.metadata = JSON.stringify({ ...meta, width: dims.width, height: dims.height });
      }
    })
  );
  return messages;
}

module.exports = {
  getImageSizeFromBuffer,
  getLocalImageSize,
  getLocalImageSizeCached,
  enrichImageMessagesWithSize
};
