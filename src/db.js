const { PrismaClient } = require('@prisma/client');

/**
 * Khởi tạo Prisma Client chuẩn Production cho PostgreSQL.
 * Sử dụng Singleton pattern để tránh tạo quá nhiều kết nối khi reload và
 * tự động đóng kết nối an toàn khi tiến trình kết thúc (Graceful Shutdown).
 */
const globalForPrisma = globalThis;

const prisma =
  globalForPrisma.__chattikoviaPrisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__chattikoviaPrisma = prisma;
}

module.exports = prisma;
