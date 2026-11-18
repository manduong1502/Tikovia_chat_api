const h = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { getImageSizeFromBuffer, getLocalImageSize, enrichImageMessagesWithSize } = h.requireSrc('utils/imageSize');
const { BASE_UPLOAD_DIR } = h.requireSrc('utils/storage');

function png(width, height) {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function gif(width, height) {
  const buf = Buffer.alloc(16);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function webpVp8x(width, height) {
  const buf = Buffer.alloc(32);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

// JPEG tối giản: SOI + (tuỳ chọn APP1 EXIF có Orientation) + SOF0
function jpeg(width, height, orientation = null) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (orientation) {
    const tiff = Buffer.alloc(8 + 2 + 12 + 4);
    tiff.write('II', 0, 'ascii');
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8); // 1 entry
    tiff.writeUInt16LE(0x0112, 10); // Orientation
    tiff.writeUInt16LE(3, 12); // SHORT
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(orientation, 18);
    const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(exif.length + 2);
    parts.push(Buffer.from([0xff, 0xe1]), len, exif);
  }
  const sof = Buffer.alloc(2 + 2 + 6);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(8, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

test('Kích thước ảnh: PNG / GIF / WebP', () => {
  assert.deepEqual(getImageSizeFromBuffer(png(1080, 1920)), { width: 1080, height: 1920 });
  assert.deepEqual(getImageSizeFromBuffer(gif(320, 240)), { width: 320, height: 240 });
  assert.deepEqual(getImageSizeFromBuffer(webpVp8x(800, 600)), { width: 800, height: 600 });
});

test('Kích thước ảnh: JPEG thường và JPEG chụp dọc từ điện thoại (EXIF xoay 90°)', () => {
  assert.deepEqual(getImageSizeFromBuffer(jpeg(4032, 3024)), { width: 4032, height: 3024 });
  assert.deepEqual(getImageSizeFromBuffer(jpeg(4032, 3024, 6)), { width: 3024, height: 4032 });
  assert.deepEqual(getImageSizeFromBuffer(jpeg(4032, 3024, 3)), { width: 4032, height: 3024 });
});

test('Kích thước ảnh: dữ liệu rác không làm lỗi', () => {
  assert.equal(getImageSizeFromBuffer(Buffer.from('not an image at all')), null);
  assert.equal(getImageSizeFromBuffer(Buffer.alloc(0)), null);
});

test('Kích thước ảnh: chỉ đọc tệp trong thư mục ảnh, chặn đường dẫn lạ', async () => {
  const dir = path.join(BASE_UPLOAD_DIR, 'images', '2026-11');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'photo.png'), png(640, 480));
  assert.deepEqual(await getLocalImageSize('/api/uploads/images/2026-11/photo.png', BASE_UPLOAD_DIR), { width: 640, height: 480 });
  assert.equal(await getLocalImageSize('/api/uploads/images/../.vapid.json', BASE_UPLOAD_DIR), null);
  assert.equal(await getLocalImageSize('/api/uploads/files/2026-11/photo.png', BASE_UPLOAD_DIR), null);
  assert.equal(await getLocalImageSize('/api/uploads/images/2026-11/missing.png', BASE_UPLOAD_DIR), null);
});

test('Lịch sử tin nhắn: ảnh cũ được bổ sung kích thước, tin khác giữ nguyên', async () => {
  const dir = path.join(BASE_UPLOAD_DIR, 'images', '2026-10');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'old.png'), png(1200, 900));
  const messages = [
    { id: '1', type: 'image', content: '/api/uploads/images/2026-10/old.png', metadata: JSON.stringify({ fileName: 'a.png' }) },
    { id: '2', type: 'image', content: '/api/uploads/images/2026-10/old.png', metadata: JSON.stringify({ width: 10, height: 20 }) },
    { id: '3', type: 'text', content: 'hello', metadata: null }
  ];
  await enrichImageMessagesWithSize(messages, BASE_UPLOAD_DIR);
  assert.deepEqual(JSON.parse(messages[0].metadata), { fileName: 'a.png', width: 1200, height: 900 });
  assert.deepEqual(JSON.parse(messages[1].metadata), { width: 10, height: 20 }, 'không ghi đè kích thước sẵn có');
  assert.equal(messages[2].metadata, null);
});
