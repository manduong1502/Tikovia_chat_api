require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');

const prisma = require('./db');
const config = require('./config');
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const taskRoutes = require('./routes/tasks');
const logRoutes = require('./routes/logs');
const integrationRoutes = require('./routes/integration');
const { sendNotificationHelper } = require('./controllers/pushController');
const { authLimiter, messageLimiter } = require('./middlewares/rateLimiter');
const errorHandler = require('./middlewares/errorHandler');
const enableWAL = require('./utils/enableWAL');
const logger = require('./utils/logger');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: config.CORS_ORIGINS,
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});
app.set('io', io);

const { PORT, JWT_SECRET } = config;

// Kích hoạt SQLite WAL Mode
enableWAL();

// Bảo mật Header HTTP, tắt CSP/Resource Policy chặn ảnh load từ Google Drive/Local static
app.use(helmet({
  crossOriginResourcePolicy: false,
}));
app.use(cors());
app.use(express.json());

// Đảm bảo thư mục upload tồn tại và public nó làm thư mục tĩnh
const uploadDir = config.UPLOAD_DIR;
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/api/uploads', express.static(path.join(__dirname, '../uploads')));


// Kích hoạt Rate Limiting trên các Route API
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/chat', messageLimiter, chatRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/integration', integrationRoutes);

// Socket.io connection mapping
// userId -> Set<socketId> để hỗ trợ multi-tab (nhiều thiết bị/tab cùng 1 user)
const userSocketMap = new Map();

// Cuộc gọi đang hoạt động: receiverId -> { from, callerName, callerAvatar, isVideo }
const activeCalls = new Map();

// --- SOCKET.IO HANDSHAKE JWT AUTHENTICATION MIDDLEWARE ---
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('Authentication error: Token missing'));
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    next();
  } catch (err) {
    return next(new Error('Authentication error: Invalid token'));
  }
});

// Socket event handlers (tách riêng để dễ bảo trì)
const setupSocketHandlers = require('./socketHandlers');
setupSocketHandlers(io, prisma, userSocketMap, activeCalls);

// --- CRON JOB NHẮC HẸN (30 giây quét một lần) ---
setInterval(async () => {
  const { contextStore } = require('./utils/context');
  contextStore.run({ userId: 'system' }, async () => {
    try {
      const now = new Date();
      const remindersToTrigger = await prisma.reminder.findMany({
        where: {
          remindAt: { lte: now },
          status: 'pending'
        },
        include: {
          message: {
            select: {
              conversationId: true
            }
          },
          creator: {
            select: {
              displayName: true
            }
          }
        }
      });

      for (const reminder of remindersToTrigger) {
        const conversationId = reminder.message.conversationId;
        io.to(conversationId).emit('reminder-trigger', {
          id: reminder.id,
          title: reminder.title,
          creatorName: reminder.creator.displayName,
          remindAt: reminder.remindAt
        });

        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { status: 'sent' }
        });
        logger.info(`Đã gửi nhắc hẹn: "${reminder.title}" cho cuộc hội thoại ${conversationId}`);
      }
    } catch (e) {
      logger.error('Lỗi quét nhắc hẹn:', e);
    }
  });
}, 30000);

// Global Error Handler
app.use(errorHandler);

const SYSTEM_USERS = {
  KHO_DONG_LANH: {
    id: '00000000-0000-0000-0000-000000000001',
    username: 'khodonglanh',
    displayName: 'Kho Đông Lạnh (Chờ nhận)',
    passwordHash: '$2b$10$tiko_system_account_hash_placeholder_never_logins'
  },
  SYSTEM_BOT: {
    id: '00000000-0000-0000-0000-000000000000',
    username: 'system_bot',
    displayName: 'Hệ thống KiotViet',
    passwordHash: '$2b$10$tiko_system_account_hash_placeholder_never_logins'
  }
};

async function seedSystemUsers() {
  try {
    for (const [key, userData] of Object.entries(SYSTEM_USERS)) {
      await prisma.user.upsert({
        where: { id: userData.id },
        update: {},
        create: {
          id: userData.id,
          username: userData.username,
          displayName: userData.displayName,
          passwordHash: userData.passwordHash,
          avatarUrl: null
        }
      });
    }
    logger.info('[System Users] Đã khởi tạo/đồng bộ các tài khoản hệ thống ảo.');
  } catch (error) {
    logger.error('Lỗi khi seed tài khoản hệ thống:', error);
  }
}

// Khởi chạy server
server.listen(PORT, async () => {
  logger.info(`Máy chủ chạy tại cổng ${PORT}`);
  await seedSystemUsers();
});
