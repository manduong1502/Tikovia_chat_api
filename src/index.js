require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const prisma = require('./db');
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // Cho phép mọi nguồn (hoặc cấu hình cụ thể khi triển khai)
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Đảm bảo thư mục upload tồn tại và public nó làm thư mục tĩnh
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);

// Socket.io connection mapping: userId -> socketId
const userSocketMap = new Map();

io.on('connection', (socket) => {
  console.log('Một client đã kết nối:', socket.id);
  let currentUserId = null;

  // Khi người dùng định danh bản thân sau khi kết nối thành công
  socket.on('register-user', async (userId) => {
    currentUserId = userId;
    userSocketMap.set(userId, socket.id);
    
    // Cập nhật trạng thái online trong DB
    try {
      await prisma.user.update({
        where: { id: userId },
        data: { status: 'online' }
      });
      // Phát sự kiện cập nhật trạng thái
      io.emit('user-status-changed', { userId, status: 'online' });
    } catch (e) {
      console.error('Lỗi cập nhật trạng thái online:', e);
    }
    
    console.log(`Người dùng ${userId} kết nối thông qua socket ${socket.id}`);
  });

  // Người dùng tham gia vào phòng chat của cuộc hội thoại
  socket.on('join-conversation', (conversationId) => {
    socket.join(conversationId);
    console.log(`Socket ${socket.id} đã tham gia phòng chat: ${conversationId}`);
  });

  // Gửi tin nhắn mới
  socket.on('send-message', async (data) => {
    const { conversationId, senderId, type, content, metadata, replyToId } = data;
    try {
      // Lưu tin nhắn vào cơ sở dữ liệu
      const newMessage = await prisma.message.create({
        data: {
          conversationId,
          senderId,
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

      // Phát tin nhắn tới tất cả thành viên trong phòng chat
      io.to(conversationId).emit('receive-message', newMessage);
      
      // Đồng thời cập nhật danh sách hội thoại cho các client khác
      io.emit('conversation-updated', { conversationId });

    } catch (error) {
      console.error('Lỗi khi gửi tin nhắn qua socket:', error);
      socket.emit('error-response', { error: 'Không thể gửi tin nhắn' });
    }
  });

  // Thả / hủy / đổi cảm xúc tin nhắn
  socket.on('toggle-reaction', async (data) => {
    const { messageId, userId, type, conversationId } = data;
    try {
      const existing = await prisma.messageReaction.findUnique({
        where: {
          messageId_userId: {
            messageId,
            userId
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
            userId,
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
    const { messageId, conversationId, userId } = data;
    try {
      const msg = await prisma.message.findUnique({
        where: { id: messageId }
      });

      if (!msg) return;

      if (msg.senderId !== userId) {
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
    const { messageId, conversationId, pinnedBy } = data;
    try {
      const msg = await prisma.message.findUnique({ where: { id: messageId } });
      if (!msg) return;

      const isPinned = !msg.isPinned;
      const updated = await prisma.message.update({
        where: { id: messageId },
        data: {
          isPinned,
          pinnedBy: isPinned ? pinnedBy : null,
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
  socket.on('typing', (data) => {
    const { conversationId, userId, displayName, isTyping } = data;
    socket.to(conversationId).emit('user-typing', { conversationId, userId, displayName, isTyping });
  });

  // --- TÍN HIỆU CUỘC GỌI WEBRTC ---
  socket.on('call-user', (data) => {
    const { userToCall, signalData, from, callerName, callerAvatar, isVideo } = data;
    const recipientSocketId = userSocketMap.get(userToCall);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('incoming-call', {
        signal: signalData,
        from,
        callerName,
        callerAvatar,
        isVideo
      });
    } else {
      socket.emit('call-failed', { reason: 'Người dùng này đang ngoại tuyến' });
    }
  });

  socket.on('answer-call', (data) => {
    const { to, signal } = data;
    const callerSocketId = userSocketMap.get(to);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call-accepted', signal);
    }
  });

  socket.on('end-call', (data) => {
    const { to } = data;
    const socketId = userSocketMap.get(to);
    if (socketId) {
      io.to(socketId).emit('call-ended-by-peer');
    }
  });

  // Khi ngắt kết nối
  socket.on('disconnect', async () => {
    console.log('Client đã ngắt kết nối:', socket.id);
    if (currentUserId) {
      userSocketMap.delete(currentUserId);
      
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
    }
  });
});

// --- CRON JOB NHẮC HẸN (30 giây quét một lần) ---
setInterval(async () => {
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
      // Bắn socket thông báo nhắc hẹn cho nhóm chat
      const conversationId = reminder.message.conversationId;
      io.to(conversationId).emit('reminder-trigger', {
        id: reminder.id,
        title: reminder.title,
        creatorName: reminder.creator.displayName,
        remindAt: reminder.remindAt
      });

      // Cập nhật trạng thái đã nhắc
      await prisma.reminder.update({
        where: { id: reminder.id },
        data: { status: 'sent' }
      });
      console.log(`Đã gửi nhắc hẹn: "${reminder.title}" cho cuộc hội thoại ${conversationId}`);
    }
  } catch (e) {
    console.error('Lỗi quét nhắc hẹn:', e);
  }
}, 30000);

// Khởi chạy server
server.listen(PORT, () => {
  console.log(`Máy chủ chạy tại cổng ${PORT}`);
});
