const { PrismaClient, Prisma } = require('@prisma/client');
const { contextStore } = require('./utils/context');

const prisma = new PrismaClient();

// Kiểm tra xem DATABASE_URL có phải là PostgreSQL/Postgres không để tránh lỗi PRAGMA trên SQLite
const isPostgres = process.env.DATABASE_URL && 
  (process.env.DATABASE_URL.startsWith('postgres://') || process.env.DATABASE_URL.startsWith('postgresql://'));

const extendedPrisma = prisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query, ...rest }) {
        const userId = contextStore.getStore()?.userId;
        
        // Nếu không có userId hoặc đang dev cục bộ với SQLite, chạy query bình thường
        if (!userId || !isPostgres) {
          return query(args);
        }

        const internalParams = rest.__internalParams;
        
        // Kiểm tra xem có đang ở trong interactive transaction (itx) hay không
        if (internalParams?.transaction?.kind === 'itx' && typeof prisma._createItxClient === 'function') {
          try {
            // Tạo transaction client tương ứng để thực hiện executeRaw trên đúng connection đó
            const transactionClient = prisma._createItxClient(internalParams.transaction);
            await transactionClient.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
            return query(args);
          } catch (err) {
            console.error('Lỗi khi thiết lập RLS trong transaction:', err);
            return query(args);
          }
        }

        // Nếu không ở trong transaction, thực thi set_config cục bộ và câu lệnh query trong một transaction mới
        // để đảm bảo chung kết nối và an toàn RLS
        try {
          const [, result] = await prisma.$transaction([
            prisma.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`,
            query(args)
          ]);
          return result;
        } catch (err) {
          console.error('Lỗi khi thiết lập RLS (non-transaction):', err);
          return query(args);
        }
      }
    }
  }
});

module.exports = extendedPrisma;
