const prisma = require('../db');

/**
 * Kích hoạt Write-Ahead Logging (WAL) Mode cho SQLite thông qua Prisma Client.
 * Chế độ WAL cho phép các tác vụ đọc chạy song song với ghi mà không bị DB Lock,
 * và PRAGMA synchronous=NORMAL giúp tăng tốc độ ghi đĩa đáng kể mà vẫn giữ an toàn dữ liệu.
 */
async function enableWAL() {
  try {
    // Kích hoạt WAL Mode
    const journalModeResult = await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
    console.log('[Database] SQLite Journal Mode:', journalModeResult);

    // Đặt synchronous về NORMAL (Tối ưu hiệu năng ghi của WAL)
    await prisma.$executeRawUnsafe('PRAGMA synchronous=NORMAL;');
    
    // Đặt dung lượng cache cho SQLite (ví dụ 10000 trang ~ 40MB bộ nhớ cache)
    await prisma.$executeRawUnsafe('PRAGMA cache_size=-10000;');

    console.log('[Database] SQLite WAL Mode & Synchronous=NORMAL cấu hình thành công.');
  } catch (error) {
    console.error('[Database] Lỗi khi kích hoạt WAL Mode cho SQLite:', error);
  }
}

module.exports = enableWAL;
