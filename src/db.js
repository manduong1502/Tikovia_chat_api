const { PrismaClient, Prisma } = require('@prisma/client');
const { contextStore } = require('./utils/context');

const prisma = new PrismaClient();

// Kiểm tra xem DATABASE_URL có phải là PostgreSQL/Postgres không để tránh lỗi PRAGMA trên SQLite
const isPostgres = process.env.DATABASE_URL && 
  (process.env.DATABASE_URL.startsWith('postgres://') || process.env.DATABASE_URL.startsWith('postgresql://'));

const extendedPrisma = prisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const userId = contextStore.getStore()?.userId;
        
        // Nếu không có userId hoặc đang dev cục bộ với SQLite, chạy query bình thường
        if (!userId || !isPostgres) {
          return query(args);
        }

        // Sử dụng instance client hiện tại (Prisma.getExtensionContext(this)) thay vì prisma global
        // giúp giữ kết nối của interactive transaction (tx) và tránh lỗi transaction lồng nhau.
        const client = Prisma.getExtensionContext(this);
        const [, result] = await client.$transaction([
          client.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`,
          query(args)
        ]);
        return result;
      }
    }
  }
});

module.exports = extendedPrisma;
