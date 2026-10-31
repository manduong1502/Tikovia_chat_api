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
const { BASE_UPLOAD_DIR } = require('./utils/storage');
const logger = require('./utils/logger');

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: config.CORS_ORIGINS,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  },
  pingTimeout: 30000,
  pingInterval: 25000
});
app.set('io', io);

const { PORT, JWT_SECRET } = config;

// Bảo mật Header HTTP, tắt crossOriginResourcePolicy để cho phép tải ảnh/ghi âm nội bộ mượt mà
app.use(
  helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false
  })
);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || config.CORS_ORIGINS === '*') {
      return callback(null, true);
    }
    if (Array.isArray(config.CORS_ORIGINS) && config.CORS_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Không được phép bởi chính sách CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-system-key']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '2mb' }));

// Đảm bảo thư mục lưu trữ SSD tồn tại và phục vụ tĩnh với các Header bảo mật + hỗ trợ tua Audio/Video (Accept-Ranges)
if (!fs.existsSync(BASE_UPLOAD_DIR)) {
  fs.mkdirSync(BASE_UPLOAD_DIR, { recursive: true });
}

app.use(
  '/api/uploads',
  express.static(BASE_UPLOAD_DIR, {
    maxAge: '365d',
    immutable: true,
    etag: true,
    setHeaders: (res, filePath) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"
      );
      const normalized = filePath.replace(/\\/g, '/');
      if (normalized.includes('/uploads/files/')) {
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
      }
    }
  })
);

// Endpoint kiểm tra sức khỏe hệ thống (Healthcheck cho Docker / Nginx)
app.get('/api/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      storage: 'local-ssd',
      uploadDir: BASE_UPLOAD_DIR,
      uptime: Math.floor(process.uptime())
    });
  } catch (err) {
    res.status(503).json({ status: 'error', error: 'Database disconnected' });
  }
});

// Kích hoạt Rate Limiting trên các Route API (authLimiter chỉ gắn riêng vào /login & /register trong authRoutes)
app.use('/api/auth', messageLimiter, authRoutes);
app.use('/api/chat', messageLimiter, chatRoutes);
app.use('/api/tasks', messageLimiter, taskRoutes);
app.use('/api/logs', authLimiter, logRoutes);
app.use('/api/integration', integrationRoutes);

// Socket.io connection mapping: userId -> Set<socketId> để hỗ trợ multi-tab
const userSocketMap = new Map();

// Cuộc gọi đang hoạt động: receiverId -> { from, callerName, callerAvatar, isVideo, conversationId, accepted }
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

// Socket event handlers
const setupSocketHandlers = require('./socketHandlers');
setupSocketHandlers(io, prisma, userSocketMap, activeCalls);

// --- CRON JOB NHẮC HẸN (15 giây quét một lần, gửi cả Socket lẫn Web Push Notification tới điện thoại) ---
const reminderInterval = setInterval(async () => {
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
              displayName: true,
              avatarUrl: true
            }
          }
        }
      });

      for (const reminder of remindersToTrigger) {
        const conversationId = reminder.conversationId || reminder.message?.conversationId;

        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { status: 'sent' }
        });

        if (!conversationId) continue;

        const members = await prisma.conversationMember.findMany({
          where: { conversationId },
          select: { userId: true, isMuted: true }
        });

        const triggerPayload = {
          id: reminder.id,
          conversationId,
          title: reminder.title,
          creatorName: reminder.creator?.displayName || 'Hệ thống',
          remindAt: reminder.remindAt
        };

        members.forEach((member) => {
          io.to(`user-${member.userId}`).emit('reminder-trigger', triggerPayload);

          // Luôn gửi Web Push Notification nhắc hẹn đến điện thoại (trừ khi đã tắt thông báo phòng đó)
          if (!member.isMuted) {
            sendNotificationHelper(member.userId, {
              title: `⏰ Nhắc hẹn: ${reminder.title}`,
              body: `Tạo bởi ${reminder.creator?.displayName || 'Thành viên'} - Đã đến giờ hẹn!`,
              icon: reminder.creator?.avatarUrl || '/pwa-192x192.png',
              tag: `reminder-${reminder.id}`,
              conversationId,
              data: {
                url: '/',
                conversationId,
                reminderId: reminder.id,
                type: 'reminder'
              }
            });
          }
        });

        logger.info(`Đã kích hoạt nhắc hẹn: "${reminder.title}" cho hội thoại ${conversationId}`);
      }
    } catch (e) {
      logger.error('Lỗi quét nhắc hẹn:', e);
    }
  });
}, 15000);

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
    for (const userData of Object.values(SYSTEM_USERS)) {
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

server.listen(PORT, async () => {
  logger.info(`Máy chủ ChatTikovia đang chạy tại cổng ${PORT} (Lưu trữ SSD: ${BASE_UPLOAD_DIR})`);
  await seedSystemUsers();
});

// Graceful Shutdown khi Docker dừng hoặc khởi động lại container
const gracefulShutdown = async (signal) => {
  logger.info(`Nhận tín hiệu ${signal}, đang đóng kết nối máy chủ an toàn...`);
  clearInterval(reminderInterval);
  server.close(async () => {
    try {
      await prisma.$disconnect();
      logger.info('Đã ngắt kết nối PostgreSQL an toàn.');
      process.exit(0);
    } catch (err) {
      logger.error('Lỗi khi đóng kết nối DB:', err);
      process.exit(1);
    }
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
