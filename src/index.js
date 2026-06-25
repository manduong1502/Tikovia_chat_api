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
    origin: '*', // Cho phép mọi nguồn
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});
app.set('io', io);

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'chattikovia_super_secret_key_12345';

// Kích hoạt SQLite WAL Mode
enableWAL();

// Bảo mật Header HTTP, tắt CSP/Resource Policy chặn ảnh load từ Google Drive/Local static
app.use(helmet({
  crossOriginResourcePolicy: false,
}));
app.use(cors());
app.use(express.json());

// Đảm bảo thư mục upload tồn tại và public nó làm thư mục tĩnh
const uploadDir = process.env.UPLOAD_DIR || './uploads';
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

// Socket.io connection mapping: userId -> socketId
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

io.on('connection', (socket) => {
  const { contextStore } = require('./utils/context');
  
  // Ghi đè socket.on để các listener sự kiện Socket.io chạy trong AsyncLocalStorage context
  const originalOn = socket.on;
  socket.on = function (event, listener) {
    return originalOn.call(this, event, (...args) => {
      contextStore.run({ userId: socket.userId }, () => {
        listener.apply(this, args);
      });
    });
  };

  // Chạy toàn bộ tiến trình kết nối trong AsyncLocalStorage context
  contextStore.run({ userId: socket.userId }, () => {
    const currentUserId = socket.userId;
    console.log(`Một client đã xác thực kết nối socket: ${socket.id} (User: ${currentUserId})`);

    // Tự động gia nhập phòng riêng của User đó để nhận thông báo real-time
    socket.join(`user-${currentUserId}`);
    userSocketMap.set(currentUserId, socket.id);

  // Cập nhật trạng thái online trong DB
  prisma.user.update({
    where: { id: currentUserId },
    data: { status: 'online' }
  }).then(() => {
    io.emit('user-status-changed', { userId: currentUserId, status: 'online' });
  }).catch(e => {
    console.error('Lỗi cập nhật trạng thái online khi connect:', e);
  });

  // Khi người dùng định danh bản thân sau khi kết nối thành công (Tương thích ngược với Client)
  socket.on('register-user', async (userId) => {
    console.log(`[register-user] Người dùng ${userId} (Verified: ${currentUserId}) đăng ký socket.`);
    
    // Đồng bộ trạng thái cuộc gọi khi kết nối/kết nối lại
    const hasActiveCall = activeCalls.has(currentUserId);
    const callData = hasActiveCall ? activeCalls.get(currentUserId) : null;
    socket.emit('call-status-sync', {
      hasActiveCall,
      callData
    });
  });

  // Lắng nghe và đồng bộ thiết bị nhận thông báo đẩy qua Socket
  socket.on('sync-push-subscription', async ({ subscription }, callback) => {
    if (!currentUserId) {
      if (callback) callback({ success: false, error: 'Chưa đăng nhập socket' });
      return;
    }

    if (!subscription || !subscription.endpoint) {
      if (callback) callback({ success: false, error: 'Dữ liệu push token không hợp lệ' });
      return;
    }

    try {
      const keysP256dh = subscription.keys?.p256dh || '';
      const keysAuth = subscription.keys?.auth || '';

      const saved = await prisma.pushSubscription.upsert({
        where: { endpoint: subscription.endpoint },
        update: {
          userId: currentUserId,
          keysP256dh,
          keysAuth
        },
        create: {
          userId: currentUserId,
          endpoint: subscription.endpoint,
          keysP256dh,
          keysAuth
        }
      });

      console.log(`[Socket.io] Đồng bộ thiết bị đẩy thành công cho user ${currentUserId}`);
      if (callback) callback({ success: true, saved });
    } catch (error) {
      console.error('Lỗi lưu đăng ký thông báo đẩy qua socket:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Người dùng tham gia vào phòng chat của cuộc hội thoại
  socket.on('join-conversation', async (conversationId) => {
    if (!currentUserId) return;
    try {
      const isMember = await prisma.conversationMember.findUnique({
        where: {
          conversationId_userId: {
            conversationId,
            userId: currentUserId
          }
        }
      });

      if (isMember) {
        socket.join(conversationId);
        console.log(`Socket ${socket.id} (User ${currentUserId}) đã tham gia phòng chat: ${conversationId}`);
      } else {
        console.warn(`Cảnh báo: User ${currentUserId} cố gắng gia nhập phòng chat không được phép: ${conversationId}`);
      }
    } catch (e) {
      console.error('Lỗi join-conversation socket:', e);
    }
  });

  // Gửi tin nhắn mới
  socket.on('send-message', async (data) => {
    const { conversationId, type, content, metadata, replyToId, tempId } = data;
    if (!currentUserId) return;

    try {
      // Xác minh người gửi thực sự là thành viên cuộc hội thoại
      const isMember = await prisma.conversationMember.findUnique({
        where: {
          conversationId_userId: {
            conversationId,
            userId: currentUserId
          }
        }
      });

      if (!isMember) {
        return socket.emit('error-response', { error: 'Bạn không có quyền gửi tin nhắn trong cuộc hội thoại này' });
      }

      // Lưu tin nhắn vào cơ sở dữ liệu
      const newMessage = await prisma.message.create({
        data: {
          conversationId,
          senderId: currentUserId,
          type,
          content,
          metadata: metadata ? JSON.stringify(metadata) : null,
          replyToId: replyToId || null
        },
        include: {
          sender: {
            select: {
              id: true,
              displayName: true,
              avatarUrl: true,
              username: true
            }
          },
          replyTo: {
            include: {
              sender: {
                select: {
                  id: true,
                  displayName: true,
                  username: true
                }
              }
            }
          },
          reactions: {
            include: {
              user: {
                select: {
                  id: true,
                  displayName: true,
                  username: true,
                  avatarUrl: true
                }
              }
            }
          }
        }
      });

      // Cập nhật thời gian cập nhật của cuộc hội thoại
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() }
      });

      // Tìm thành viên trong cuộc hội thoại để gửi real-time socket và push notification
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { members: { include: { user: true } } }
      });

      if (conv) {
        // Gửi tin nhắn real-time tới mọi thiết bị (phòng user-*) của các thành viên trong nhóm
        conv.members.forEach(member => {
          io.to(`user-${member.userId}`).emit('receive-message', {
            ...newMessage,
            tempId: tempId || null
          });
        });

        // Đồng thời cập nhật danh sách hội thoại cho các client khác
        io.emit('conversation-updated', { conversationId });

        const senderName = newMessage.sender?.displayName || 'Người dùng';
        const isGroupMsg = conv.isGroup;
        const pushTitle = isGroupMsg ? `${conv.name} (${senderName})` : senderName;
        
        let pushBody = '';
        if (type === 'text') pushBody = content;
        else if (type === 'image') pushBody = '📷 [Hình ảnh]';
        else if (type === 'file') pushBody = '📁 [Tài liệu]';
        else if (type === 'voice') pushBody = '🎙️ [Tin nhắn thoại]';
        else if (type === 'location') pushBody = '📍 [Vị trí]';
        else if (type === 'sticker') pushBody = '✨ [Sticker]';
        else if (type === 'reminder') pushBody = '⏰ [Nhắc hẹn]';
        else if (type === 'call') pushBody = `📞 ${content}`;
        else pushBody = 'Bạn có tin nhắn mới';

        const pushPayload = {
          title: pushTitle,
          body: pushBody,
          url: '/',
          conversationId: conversationId,
          icon: newMessage.sender?.avatarUrl 
            ? (newMessage.sender.avatarUrl.startsWith('http') 
                ? newMessage.sender.avatarUrl 
                : `${process.env.APP_URL || 'https://chat.tikovia.vn'}${newMessage.sender.avatarUrl}`)
            : 'https://chat.tikovia.vn/pwa-192x192.png'
        };

        const otherMembers = conv.members.filter(m => m.userId !== currentUserId);
        otherMembers.forEach(member => {
          sendNotificationHelper(member.userId, pushPayload);
        });
      }

    } catch (error) {
      console.error('Lỗi khi gửi tin nhắn qua socket:', error);
      socket.emit('error-response', { error: 'Không thể gửi tin nhắn' });
    }
  });

  // Thả / hủy / đổi cảm xúc tin nhắn
  socket.on('toggle-reaction', async (data) => {
    const { messageId, type, conversationId } = data;
    if (!currentUserId) return;
    try {
      // Xác minh thành viên hội thoại
      const isMember = await prisma.conversationMember.findUnique({
        where: {
          conversationId_userId: {
            conversationId,
            userId: currentUserId
          }
        }
      });

      if (!isMember) return;

      // Xác minh tin nhắn thuộc cuộc hội thoại đó
      const msg = await prisma.message.findUnique({
        where: { id: messageId },
        select: { conversationId: true }
      });

      if (!msg || msg.conversationId !== conversationId) return;

      const existing = await prisma.messageReaction.findUnique({
        where: {
          messageId_userId: {
            messageId,
            userId: currentUserId
          }
        }
      });

      if (existing) {
        if (existing.type === type) {
          await prisma.messageReaction.delete({
            where: { id: existing.id }
          });
        } else {
          await prisma.messageReaction.update({
            where: { id: existing.id },
            data: { type }
          });
        }
      } else {
        await prisma.messageReaction.create({
          data: {
            messageId,
            userId: currentUserId,
            type
          }
        });
      }

      // Lấy danh sách cảm xúc mới nhất của tin nhắn
      const updatedReactions = await prisma.messageReaction.findMany({
        where: { messageId },
        include: {
          user: {
            select: {
              id: true,
              displayName: true,
              username: true,
              avatarUrl: true
            }
          }
        }
      });

      io.to(conversationId).emit('message-reaction-updated', {
        messageId,
        conversationId,
        reactions: updatedReactions
      });
    } catch (e) {
      console.error('Lỗi socket thả cảm xúc:', e);
    }
  });

  // Gỡ / thu hồi tin nhắn
  socket.on('recall-message', async (data) => {
    const { messageId, conversationId } = data;
    if (!currentUserId) return;
    try {
      const isMember = await prisma.conversationMember.findUnique({
        where: {
          conversationId_userId: {
            conversationId,
            userId: currentUserId
          }
        }
      });

      if (!isMember) return;

      const msg = await prisma.message.findUnique({
        where: { id: messageId }
      });

      if (!msg || msg.conversationId !== conversationId) return;

      // Chỉ người gửi mới được quyền thu hồi tin nhắn của mình
      if (msg.senderId !== currentUserId) {
        return socket.emit('error-response', { error: 'Bạn không có quyền thu hồi tin nhắn này' });
      }

      await prisma.message.update({
        where: { id: messageId },
        data: {
          isRecalled: true,
          content: null,
          metadata: null,
          isPinned: false,
          pinnedBy: null,
          pinnedAt: null
        }
      });

      io.to(conversationId).emit('message-recalled', {
        messageId,
        conversationId
      });
    } catch (e) {
      console.error('Lỗi socket thu hồi tin nhắn:', e);
    }
  });

  // Ghim tin nhắn
  socket.on('pin-message', async (data) => {
    const { messageId, conversationId } = data;
    if (!currentUserId) return;
    try {
      const isMember = await prisma.conversationMember.findUnique({
        where: {
          conversationId_userId: {
            conversationId,
            userId: currentUserId
          }
        }
      });

      if (!isMember) return;

      const msg = await prisma.message.findUnique({ where: { id: messageId } });
      if (!msg || msg.conversationId !== conversationId) return;

      const isPinned = !msg.isPinned;
      const updated = await prisma.message.update({
        where: { id: messageId },
        data: {
          isPinned,
          pinnedBy: isPinned ? currentUserId : null,
          pinnedAt: isPinned ? new Date() : null
        },
        include: {
          sender: {
            select: {
              id: true,
              displayName: true
            }
          }
        }
      });

      io.to(conversationId).emit('message-pin-toggled', {
        messageId,
        conversationId,
        isPinned,
        message: updated
      });
    } catch (e) {
      console.error('Lỗi ghim tin nhắn qua socket:', e);
    }
  });

  // Gõ phím tin nhắn (typing indicator)
  socket.on('typing', async (data) => {
    const { conversationId, displayName, isTyping } = data;
    if (!currentUserId) return;
    try {
      const isMember = await prisma.conversationMember.findUnique({
        where: {
          conversationId_userId: {
            conversationId,
            userId: currentUserId
          }
        }
      });

      if (!isMember) return;

      socket.to(conversationId).emit('user-typing', { conversationId, userId: currentUserId, displayName, isTyping });
    } catch (e) {
      console.error('Lỗi socket typing:', e);
    }
  });

  // --- TÍN HIỆU CUỘC GỌI WEBRTC ---
  socket.on('call-user', async (data) => {
    const { userToCall, signalData, callerName, callerAvatar, isVideo, conversationId } = data;
    if (!currentUserId) return;

    try {
      // Xác thực cả caller và receiver đều là thành viên phòng chat
      const [isCallerMember, isReceiverMember] = await Promise.all([
        prisma.conversationMember.findUnique({
          where: { conversationId_userId: { conversationId, userId: currentUserId } }
        }),
        prisma.conversationMember.findUnique({
          where: { conversationId_userId: { conversationId, userId: userToCall } }
        })
      ]);

      if (!isCallerMember || !isReceiverMember) {
        return socket.emit('error-response', { error: 'Không thể thực hiện cuộc gọi ngoài phòng chat' });
      }

      // Lưu cuộc gọi đang hoạt động
      activeCalls.set(userToCall, {
        signal: signalData,
        from: currentUserId,
        callerName,
        callerAvatar,
        isVideo,
        conversationId
      });

      // Luôn gửi push notification cuộc gọi để đánh thức thiết bị di động chạy nền (High Priority)
      const callType = isVideo ? 'cuộc gọi video' : 'cuộc gọi thường';
      sendNotificationHelper(userToCall, {
        title: '📞 Cuộc gọi đến',
        body: `${callerName} đang gọi ${callType} cho bạn...`,
        url: '/',
        tag: 'incoming-call',
        isCall: true,
        conversationId
      });

      const recipientSocketId = userSocketMap.get(userToCall);
      if (recipientSocketId) {
        io.to(recipientSocketId).emit('incoming-call', {
          signal: signalData,
          from: currentUserId,
          callerName,
          callerAvatar,
          isVideo,
          conversationId
        });
      }
    } catch (e) {
      console.error('Lỗi socket call-user:', e);
    }
  });

  socket.on('answer-call', (data) => {
    const { to, signal } = data;
    if (!currentUserId) return;
    
    // Tìm cuộc gọi liên quan để đảm bảo user là receiver hợp lệ
    const call = activeCalls.get(currentUserId);
    if (!call || call.from !== to) return;

    const callerSocketId = userSocketMap.get(to);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call-accepted', signal);
    }
  });

  socket.on('end-call', (data) => {
    const { to } = data;
    if (!currentUserId) return;
    
    // Dọn dẹp cuộc gọi khỏi danh sách hoạt động
    activeCalls.delete(to);
    for (const [receiverId, call] of activeCalls.entries()) {
      if (call.from === to || receiverId === to || call.from === currentUserId || receiverId === currentUserId) {
        activeCalls.delete(receiverId);
      }
    }

    const socketId = userSocketMap.get(to);
    if (socketId) {
      io.to(socketId).emit('call-ended-by-peer');
    }
  });

  // Khi ngắt kết nối
  socket.on('disconnect', async () => {
    console.log('Client đã ngắt kết nối:', socket.id);
    if (currentUserId) {
      if (userSocketMap.get(currentUserId) === socket.id) {
        userSocketMap.delete(currentUserId);
      }
      
      // Đợi 5 giây trước khi chuyển thành offline đề phòng reload trang hoặc mất kết nối tạm thời
      setTimeout(async () => {
        if (!userSocketMap.has(currentUserId)) {
          try {
            await prisma.user.update({
              where: { id: currentUserId },
              data: { status: 'offline', lastSeen: new Date() }
            });
            io.emit('user-status-changed', { userId: currentUserId, status: 'offline' });
          } catch (e) {
            console.error('Lỗi cập nhật trạng thái offline:', e);
          }
        }
      }, 5000);

      // Đợi 15 giây đề phòng mất kết nối tạm thời/chạy nền, nếu thực sự offline thì kết thúc cuộc gọi liên quan
      const disconnectedUserId = currentUserId;
      setTimeout(() => {
        if (!userSocketMap.has(disconnectedUserId)) {
          for (const [receiverId, call] of activeCalls.entries()) {
            if (call.from === disconnectedUserId || receiverId === disconnectedUserId) {
              console.log(`[Socket.io] User ${disconnectedUserId} offline quá 15s. Tự động huỷ cuộc gọi giữa ${call.from} và ${receiverId}`);
              activeCalls.delete(receiverId);
              const otherUserId = call.from === disconnectedUserId ? receiverId : call.from;
              const otherSocketId = userSocketMap.get(otherUserId);
              if (otherSocketId) {
                io.to(otherSocketId).emit('call-ended-by-peer');
              }
            }
          }
        }
      }, 15000);
    }
  });
  });
});

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
