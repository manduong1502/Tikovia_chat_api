/**
 * Socket.io Event Handlers cho ChatTikovia
 * Tách riêng từ index.js để dễ bảo trì và test.
 * Logic xử lý giữ nguyên 100%, chỉ di chuyển vị trí.
 */

const { sendNotificationHelper } = require('./controllers/pushController');

/**
 * Thiết lập tất cả socket event handlers
 * @param {import('socket.io').Server} io Socket.io server instance
 * @param {import('@prisma/client').PrismaClient} prisma Prisma client instance
 * @param {Map<string, Set<string>>} userSocketMap userId -> Set<socketId>
 * @param {Map<string, object>} activeCalls receiverId -> { from, callerName, callerAvatar, isVideo }
 */
function setupSocketHandlers(io, prisma, userSocketMap, activeCalls) {
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
      // Thêm socketId vào Set để hỗ trợ multi-tab
      if (!userSocketMap.has(currentUserId)) {
        userSocketMap.set(currentUserId, new Set());
      }
      userSocketMap.get(currentUserId).add(socket.id);

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

            // Chỉ emit cho members của conversation thay vì toàn cầu
            conv.members.forEach(member => {
              io.to(`user-${member.userId}`).emit('conversation-updated', { conversationId });
            });

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

      // Sửa đổi tin nhắn
      socket.on('edit-message', async (data) => {
        const { messageId, content, conversationId } = data;
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

          // Chỉ người gửi mới được quyền sửa tin nhắn của mình và không được sửa tin đã gỡ/thu hồi
          if (msg.senderId !== currentUserId || msg.isRecalled) {
            return socket.emit('error-response', { error: 'Bạn không có quyền sửa tin nhắn này' });
          }

          await prisma.message.update({
            where: { id: messageId },
            data: { content }
          });

          io.to(conversationId).emit('message-edited', {
            messageId,
            conversationId,
            content
          });
        } catch (e) {
          console.error('Lỗi socket sửa tin nhắn:', e);
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

          // Gửi incoming-call tới tất cả tab/thiết bị của receiver
          const recipientSockets = userSocketMap.get(userToCall);
          if (recipientSockets && recipientSockets.size > 0) {
            for (const sid of recipientSockets) {
              io.to(sid).emit('incoming-call', {
                signal: signalData,
                from: currentUserId,
                callerName,
                callerAvatar,
                isVideo,
                conversationId
              });
            }
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

        const callerSockets = userSocketMap.get(to);
        if (callerSockets && callerSockets.size > 0) {
          for (const sid of callerSockets) {
            io.to(sid).emit('call-accepted', signal);
          }
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

        const targetSockets = userSocketMap.get(to);
        if (targetSockets && targetSockets.size > 0) {
          for (const sid of targetSockets) {
            io.to(sid).emit('call-ended-by-peer');
          }
        }
      });

      // Khi ngắt kết nối
      socket.on('disconnect', async () => {
        console.log('Client đã ngắt kết nối:', socket.id);
        if (currentUserId) {
          // Xóa socketId khỏi Set thay vì xóa toàn bộ user
          const socketSet = userSocketMap.get(currentUserId);
          if (socketSet) {
            socketSet.delete(socket.id);
            if (socketSet.size === 0) {
              userSocketMap.delete(currentUserId);
            }
          }
          
          // Đợi 5 giây trước khi chuyển thành offline đề phòng reload trang hoặc mất kết nối tạm thời
          setTimeout(async () => {
            // Chỉ set offline nếu không còn socket nào kết nối (tất cả tab đã đóng)
            const remainingSockets = userSocketMap.get(currentUserId);
            if (!remainingSockets || remainingSockets.size === 0) {
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
            const remainingCallSockets = userSocketMap.get(disconnectedUserId);
            if (!remainingCallSockets || remainingCallSockets.size === 0) {
              for (const [receiverId, call] of activeCalls.entries()) {
                if (call.from === disconnectedUserId || receiverId === disconnectedUserId) {
                  console.log(`[Socket.io] User ${disconnectedUserId} offline quá 15s. Tự động huỷ cuộc gọi giữa ${call.from} và ${receiverId}`);
                  activeCalls.delete(receiverId);
                  const otherUserId = call.from === disconnectedUserId ? receiverId : call.from;
                  const otherSockets = userSocketMap.get(otherUserId);
                  if (otherSockets && otherSockets.size > 0) {
                    for (const sid of otherSockets) {
                      io.to(sid).emit('call-ended-by-peer');
                    }
                  }
                }
              }
            }
          }, 15000);
        }
      });
    });
  });
}

module.exports = setupSocketHandlers;
