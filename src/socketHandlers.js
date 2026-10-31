/**
 * Socket.io Event Handlers cho ChatTikovia (Production Edition)
 */

const { sendNotificationHelper } = require('./controllers/pushController');
const { deleteLocalFile } = require('./utils/storage');
const logger = require('./utils/logger');

const VALID_MESSAGE_TYPES = new Set([
  'text',
  'image',
  'file',
  'voice',
  'location',
  'sticker',
  'reminder',
  'task',
  'call',
  'system'
]);

const MAX_MESSAGE_LENGTH = 10000;

/**
 * Helper gửi sự kiện tới tất cả thiết bị/tab của toàn bộ thành viên trong một cuộc hội thoại
 */
async function emitToConversationMembers(io, prisma, conversationId, eventName, payload, excludeUserId = null) {
  const members = await prisma.conversationMember.findMany({
    where: { conversationId },
    select: { userId: true }
  });
  for (const m of members) {
    if (excludeUserId && m.userId === excludeUserId) continue;
    io.to(`user-${m.userId}`).emit(eventName, payload);
  }
}

/**
 * Thiết lập tất cả socket event handlers
 * @param {import('socket.io').Server} io Socket.io server instance
 * @param {import('@prisma/client').PrismaClient} prisma Prisma client instance
 * @param {Map<string, Set<string>>} userSocketMap userId -> Set<socketId>
 * @param {Map<string, object>} activeCalls receiverId -> { from, callerName, callerAvatar, isVideo, conversationId, accepted }
 */
function setupSocketHandlers(io, prisma, userSocketMap, activeCalls) {
  io.on('connection', (socket) => {
    const { contextStore } = require('./utils/context');

    // Bộ giới hạn tần suất sự kiện trên mỗi kết nối Socket (Chống spam/flood)
    let eventCount = 0;
    let windowStart = Date.now();
    const checkSocketRateLimit = () => {
      const now = Date.now();
      if (now - windowStart > 10000) {
        windowStart = now;
        eventCount = 0;
      }
      eventCount += 1;
      return eventCount <= 45;
    };

    const originalOn = socket.on;
    socket.on = function (event, listener) {
      return originalOn.call(this, event, (...args) => {
        if (event !== 'disconnect' && !checkSocketRateLimit()) {
          socket.emit('error-response', { error: 'Bạn thao tác quá nhanh, vui lòng thử lại sau giây lát.' });
          return;
        }
        contextStore.run({ userId: socket.userId }, () => {
          listener.apply(this, args);
        });
      });
    };

    contextStore.run({ userId: socket.userId }, () => {
      const currentUserId = socket.userId;
      logger.info(`Socket kết nối: ${socket.id} (User: ${currentUserId})`);

      socket.join(`user-${currentUserId}`);

      const wasOffline = !userSocketMap.has(currentUserId) || userSocketMap.get(currentUserId).size === 0;
      if (!userSocketMap.has(currentUserId)) {
        userSocketMap.set(currentUserId, new Set());
      }
      userSocketMap.get(currentUserId).add(socket.id);

      if (wasOffline) {
        prisma.user
          .update({
            where: { id: currentUserId },
            data: { status: 'online', lastSeen: new Date() }
          })
          .then(() => {
            io.emit('user-status-changed', { userId: currentUserId, status: 'online' });
          })
          .catch((e) => {
            logger.error('Lỗi cập nhật trạng thái online khi connect:', e);
          });
      }

      // Khi người dùng định danh bản thân sau khi kết nối thành công
      socket.on('register-user', async () => {
        const hasActiveCall = activeCalls.has(currentUserId);
        const callData = hasActiveCall ? activeCalls.get(currentUserId) : null;
        socket.emit('call-status-sync', {
          hasActiveCall,
          callData
        });
      });

      // Đồng bộ thiết bị nhận thông báo đẩy qua Socket
      socket.on('sync-push-subscription', async ({ subscription } = {}, callback) => {
        if (!currentUserId) {
          if (typeof callback === 'function') callback({ success: false, error: 'Chưa đăng nhập socket' });
          return;
        }

        if (!subscription || !subscription.endpoint) {
          if (typeof callback === 'function') callback({ success: false, error: 'Dữ liệu push token không hợp lệ' });
          return;
        }

        try {
          const keysP256dh = subscription.keys?.p256dh || '';
          const keysAuth = subscription.keys?.auth || '';
          const userAgent = socket.handshake.headers?.['user-agent']
            ? String(socket.handshake.headers['user-agent']).slice(0, 500)
            : null;

          if (!keysP256dh || !keysAuth) {
            if (typeof callback === 'function') callback({ success: false, error: 'Thiếu khoá mã hoá p256dh/auth' });
            return;
          }

          const saved = await prisma.pushSubscription.upsert({
            where: { endpoint: subscription.endpoint },
            update: {
              userId: currentUserId,
              keysP256dh,
              keysAuth,
              userAgent
            },
            create: {
              userId: currentUserId,
              endpoint: subscription.endpoint,
              keysP256dh,
              keysAuth,
              userAgent
            }
          });

          if (typeof callback === 'function') callback({ success: true, saved });
        } catch (error) {
          logger.error('Lỗi lưu đăng ký thông báo đẩy qua socket:', error);
          if (typeof callback === 'function') callback({ success: false, error: error.message });
        }
      });

      // Người dùng tham gia vào phòng chat của cuộc hội thoại
      socket.on('join-conversation', async (conversationId) => {
        if (!currentUserId || !conversationId) return;
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
          }
        } catch (e) {
          logger.error('Lỗi join-conversation socket:', e);
        }
      });

      // Gửi tin nhắn mới
      socket.on('send-message', async (data = {}) => {
        const { conversationId, type = 'text', content, metadata, replyToId, tempId } = data;
        if (!currentUserId || !conversationId) return;

        if (!VALID_MESSAGE_TYPES.has(type)) {
          return socket.emit('error-response', { error: 'Loại tin nhắn không hợp lệ' });
        }

        if (content && String(content).length > MAX_MESSAGE_LENGTH) {
          return socket.emit('error-response', {
            error: `Nội dung tin nhắn không được vượt quá ${MAX_MESSAGE_LENGTH} ký tự`
          });
        }

        try {
          const conv = await prisma.conversation.findUnique({
            where: { id: conversationId },
            include: {
              members: {
                include: {
                  user: {
                    select: {
                      id: true,
                      username: true,
                      displayName: true,
                      avatarUrl: true
                    }
                  }
                }
              }
            }
          });

          const isMember = conv?.members?.some((m) => m.userId === currentUserId);
          if (!conv || !isMember) {
            return socket.emit('error-response', { error: 'Bạn không có quyền gửi tin nhắn trong cuộc hội thoại này' });
          }

          const now = new Date();

          const [newMessage] = await prisma.$transaction([
            prisma.message.create({
              data: {
                conversationId,
                senderId: currentUserId,
                type,
                content: content !== undefined && content !== null ? String(content) : null,
                metadata: metadata
                  ? typeof metadata === 'string'
                    ? metadata
                    : JSON.stringify(metadata)
                  : null,
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
            }),
            prisma.conversation.update({
              where: { id: conversationId },
              data: { updatedAt: now }
            }),
            prisma.conversationMember.update({
              where: {
                conversationId_userId: {
                  conversationId,
                  userId: currentUserId
                }
              },
              data: { lastReadAt: now }
            })
          ]);

          const realtimePayload = {
            ...newMessage,
            tempId: tempId || null
          };

          conv.members.forEach((member) => {
            io.to(`user-${member.userId}`).emit('receive-message', realtimePayload);
          });

          const senderName = newMessage.sender?.displayName || 'Người dùng';
          const isGroupMsg = conv.isGroup;
          const baseTitle = isGroupMsg ? `${conv.name || 'Nhóm chat'} (${senderName})` : senderName;

          let pushBody = '';
          if (type === 'text') pushBody = String(content || '');
          else if (type === 'image') pushBody = '📷 Đã gửi một hình ảnh';
          else if (type === 'file') {
            let fName = '';
            try {
              const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
              fName = parsed?.fileName ? `: ${parsed.fileName}` : '';
            } catch (e) {}
            pushBody = `📁 Đã gửi một tệp đính kèm${fName}`;
          } else if (type === 'voice') pushBody = '🎙️ Đã gửi một tin nhắn thoại';
          else if (type === 'location') pushBody = '📍 Đã chia sẻ một vị trí';
          else if (type === 'sticker') pushBody = '✨ Đã gửi một nhãn dán';
          else if (type === 'reminder') pushBody = `⏰ Nhắc hẹn: ${content || ''}`;
          else if (type === 'call') pushBody = `📞 ${content || 'Cuộc gọi'}`;
          else pushBody = 'Bạn có tin nhắn mới';

          const otherMembers = conv.members.filter((m) => m.userId !== currentUserId);
          const rawText = type === 'text' ? String(content || '').toLowerCase() : '';

          otherMembers.forEach((member) => {
            const memberDisplayName = (member.user?.displayName || '').toLowerCase();
            const memberUsername = (member.user?.username || '').toLowerCase();
            const isMentioned =
              rawText &&
              ((memberDisplayName && rawText.includes(`@${memberDisplayName}`)) ||
                (memberUsername && rawText.includes(`@${memberUsername}`)) ||
                rawText.includes('@all') ||
                rawText.includes('@tất cả'));

            // Nếu người nhận đã tắt thông báo cuộc hội thoại và không được @tag trực tiếp thì bỏ qua Push
            if (member.isMuted && !isMentioned) {
              return;
            }

            const finalTitle = isMentioned ? `🔔 ${senderName} đã nhắc đến bạn` : baseTitle;

            sendNotificationHelper(member.userId, {
              title: finalTitle,
              body: pushBody,
              url: '/',
              conversationId,
              tag: `conv-${conversationId}`,
              icon: newMessage.sender?.avatarUrl || '/pwa-192x192.png',
              data: {
                url: '/',
                conversationId,
                messageId: newMessage.id,
                type: 'message'
              }
            });
          });
        } catch (error) {
          logger.error('Lỗi khi gửi tin nhắn qua socket:', error);
          socket.emit('error-response', { error: 'Không thể gửi tin nhắn' });
        }
      });

      // Thả / hủy / đổi cảm xúc tin nhắn
      socket.on('toggle-reaction', async (data = {}) => {
        const { messageId, type, conversationId } = data;
        if (!currentUserId || !messageId || !conversationId || !type) return;
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
            where: { id: messageId },
            select: { conversationId: true, isRecalled: true }
          });

          if (!msg || msg.conversationId !== conversationId || msg.isRecalled) return;

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
                data: { type: String(type).slice(0, 16) }
              });
            }
          } else {
            await prisma.messageReaction.create({
              data: {
                messageId,
                userId: currentUserId,
                type: String(type).slice(0, 16)
              }
            });
          }

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

          await emitToConversationMembers(io, prisma, conversationId, 'message-reaction-updated', {
            messageId,
            conversationId,
            reactions: updatedReactions
          });
        } catch (e) {
          logger.error('Lỗi socket thả cảm xúc:', e);
        }
      });

      // Gỡ / thu hồi tin nhắn (Kèm tự động xóa file vật lý trên SSD nếu là ảnh/file/ghi âm)
      socket.on('recall-message', async (data = {}) => {
        const { messageId, conversationId } = data;
        if (!currentUserId || !messageId || !conversationId) return;
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

          if (msg.senderId !== currentUserId) {
            return socket.emit('error-response', { error: 'Bạn không có quyền thu hồi tin nhắn này' });
          }

          const oldContent = msg.content;
          const oldType = msg.type;

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

          // Nếu tin nhắn bị thu hồi là tệp đính kèm lưu trên SSD cục bộ, xóa tệp để giải phóng dung lượng
          if (['image', 'file', 'voice'].includes(oldType) && oldContent) {
            deleteLocalFile(oldContent).catch(() => {});
          }

          await emitToConversationMembers(io, prisma, conversationId, 'message-recalled', {
            messageId,
            conversationId
          });
        } catch (e) {
          logger.error('Lỗi socket thu hồi tin nhắn:', e);
        }
      });

      // Ghim tin nhắn
      socket.on('pin-message', async (data = {}) => {
        const { messageId, conversationId } = data;
        if (!currentUserId || !messageId || !conversationId) return;
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
          if (!msg || msg.conversationId !== conversationId || msg.isRecalled) return;

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

          await emitToConversationMembers(io, prisma, conversationId, 'message-pin-toggled', {
            messageId,
            conversationId,
            isPinned,
            message: updated
          });
        } catch (e) {
          logger.error('Lỗi ghim tin nhắn qua socket:', e);
        }
      });

      // Sửa đổi tin nhắn
      socket.on('edit-message', async (data = {}) => {
        const { messageId, content, conversationId } = data;
        if (!currentUserId || !messageId || !conversationId || !content || !String(content).trim()) return;

        const cleanContent = String(content).trim();
        if (cleanContent.length > MAX_MESSAGE_LENGTH) {
          return socket.emit('error-response', {
            error: `Nội dung tin nhắn không được vượt quá ${MAX_MESSAGE_LENGTH} ký tự`
          });
        }

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

          if (msg.senderId !== currentUserId || msg.isRecalled || msg.type !== 'text') {
            return socket.emit('error-response', { error: 'Bạn không có quyền sửa tin nhắn này' });
          }

          await prisma.message.update({
            where: { id: messageId },
            data: { content: cleanContent }
          });

          await emitToConversationMembers(io, prisma, conversationId, 'message-edited', {
            messageId,
            conversationId,
            content: cleanContent
          });
        } catch (e) {
          logger.error('Lỗi socket sửa tin nhắn:', e);
        }
      });

      // Gõ phím tin nhắn (typing indicator)
      socket.on('typing', async (data = {}) => {
        const { conversationId, displayName, isTyping } = data;
        if (!currentUserId || !conversationId) return;
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

          await emitToConversationMembers(
            io,
            prisma,
            conversationId,
            'user-typing',
            {
              conversationId,
              userId: currentUserId,
              displayName: displayName || 'Thành viên',
              isTyping: Boolean(isTyping)
            },
            currentUserId
          );
        } catch (e) {
          logger.error('Lỗi socket typing:', e);
        }
      });

      // --- TÍN HIỆU CUỘC GỌI WEBRTC ---
      socket.on('call-user', async (data = {}) => {
        const { userToCall, signalData, callerName, callerAvatar, isVideo, conversationId } = data;
        if (!currentUserId || !userToCall || !conversationId) return;

        try {
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

          // Kiểm tra nếu người nhận đang bận trong một cuộc gọi khác
          let isReceiverBusy = activeCalls.has(userToCall);
          if (!isReceiverBusy) {
            for (const existingCall of activeCalls.values()) {
              if (existingCall.from === userToCall) {
                isReceiverBusy = true;
                break;
              }
            }
          }
          if (isReceiverBusy) {
            return socket.emit('call-failed', { reason: 'Người nhận đang bận trong một cuộc gọi khác.' });
          }

          // Tự động dọn dẹp cuộc gọi trên Server sau 45 giây nếu người nhận không bắt máy (phòng trường hợp máy người gọi mất mạng đột ngột)
          const ringingTimeoutId = setTimeout(() => {
            const pendingCall = activeCalls.get(userToCall);
            if (pendingCall && pendingCall.from === currentUserId && !pendingCall.accepted) {
              activeCalls.delete(userToCall);
              io.to(`user-${userToCall}`).emit('call-ended-by-peer');
              io.to(`user-${currentUserId}`).emit('call-ended-by-peer');
              sendNotificationHelper(
                userToCall,
                {
                  type: 'call-ended',
                  title: '📞 Cuộc gọi nhỡ',
                  body: `Bạn có cuộc gọi nhỡ từ ${callerName || 'đồng nghiệp'}`,
                  tag: 'incoming-call',
                  conversationId,
                  url: '/'
                },
                { TTL: 30, urgency: 'high', topic: 'incoming-call' }
              );
            }
          }, 45000);

          activeCalls.set(userToCall, {
            signal: signalData,
            from: currentUserId,
            callerName,
            callerAvatar,
            isVideo: Boolean(isVideo),
            conversationId,
            accepted: false,
            timeoutId: ringingTimeoutId
          });

          const callType = isVideo ? 'cuộc gọi video' : 'cuộc gọi thoại';
          sendNotificationHelper(
            userToCall,
            {
              title: `📞 ${callerName || 'Cuộc gọi đến'}`,
              body: `Đang gọi ${callType} cho bạn... Chạm để trả lời`,
              url: '/',
              tag: 'incoming-call',
              isCall: true,
              conversationId,
              icon: callerAvatar || '/pwa-192x192.png',
              data: {
                url: '/',
                conversationId,
                type: 'incoming-call'
              }
            },
            { TTL: 60, urgency: 'high', topic: 'incoming-call' }
          );

          const recipientSockets = userSocketMap.get(userToCall);
          if (recipientSockets && recipientSockets.size > 0) {
            for (const sid of recipientSockets) {
              io.to(sid).emit('incoming-call', {
                signal: signalData,
                from: currentUserId,
                callerName,
                callerAvatar,
                isVideo: Boolean(isVideo),
                conversationId
              });
            }
          }
        } catch (e) {
          logger.error('Lỗi socket call-user:', e);
        }
      });

      socket.on('answer-call', (data = {}) => {
        const { to, signal } = data;
        if (!currentUserId || !to) return;

        const call = activeCalls.get(currentUserId);
        if (!call || call.from !== to) return;

        if (call.timeoutId) {
          clearTimeout(call.timeoutId);
          call.timeoutId = null;
        }
        call.accepted = true;
        activeCalls.set(currentUserId, call);

        const callerSockets = userSocketMap.get(to);
        if (callerSockets && callerSockets.size > 0) {
          for (const sid of callerSockets) {
            io.to(sid).emit('call-accepted', signal);
          }
        }
      });

      socket.on('end-call', (data = {}) => {
        const { to } = data;
        if (!currentUserId || !to) return;

        let validPeerId = null;
        let cancelledRingingReceiverId = null;
        let endedConversationId = null;

        for (const [receiverId, call] of activeCalls.entries()) {
          const isCallerEnding = call.from === currentUserId && receiverId === to;
          const isReceiverEnding = receiverId === currentUserId && call.from === to;

          if (isCallerEnding || isReceiverEnding) {
            validPeerId = to;
            endedConversationId = call.conversationId;
            if (call.timeoutId) {
              clearTimeout(call.timeoutId);
            }
            if (isCallerEnding && !call.accepted) {
              cancelledRingingReceiverId = receiverId;
            }
            activeCalls.delete(receiverId);
          }
        }

        // Chỉ phát tín hiệu kết thúc cuộc gọi nếu currentUserId thực sự nằm trong cuộc gọi với 'to'
        if (!validPeerId) return;

        const targetSockets = userSocketMap.get(validPeerId);
        if (targetSockets && targetSockets.size > 0) {
          for (const sid of targetSockets) {
            io.to(sid).emit('call-ended-by-peer');
          }
        }

        // Nếu người gọi tắt máy khi người nhận chưa bắt máy, gửi Push tới điện thoại để đóng thông báo đổ chuông
        if (cancelledRingingReceiverId) {
          sendNotificationHelper(
            cancelledRingingReceiverId,
            {
              type: 'call-ended',
              title: '📞 Cuộc gọi nhỡ',
              body: 'Cuộc gọi đến đã kết thúc',
              tag: 'incoming-call',
              conversationId: endedConversationId,
              url: '/'
            },
            { TTL: 30, urgency: 'high', topic: 'incoming-call' }
          );
        }
      });

      // Khi ngắt kết nối
      socket.on('disconnect', async () => {
        if (!currentUserId) return;

        const socketSet = userSocketMap.get(currentUserId);
        if (socketSet) {
          socketSet.delete(socket.id);
          if (socketSet.size === 0) {
            userSocketMap.delete(currentUserId);
          }
        }

        setTimeout(async () => {
          const remainingSockets = userSocketMap.get(currentUserId);
          if (!remainingSockets || remainingSockets.size === 0) {
            try {
              await prisma.user.update({
                where: { id: currentUserId },
                data: { status: 'offline', lastSeen: new Date() }
              });
              io.emit('user-status-changed', { userId: currentUserId, status: 'offline' });
            } catch (e) {
              logger.error('Lỗi cập nhật trạng thái offline:', e);
            }
          }
        }, 5000);

        const disconnectedUserId = currentUserId;
        setTimeout(() => {
          const remainingCallSockets = userSocketMap.get(disconnectedUserId);
          if (!remainingCallSockets || remainingCallSockets.size === 0) {
            for (const [receiverId, call] of activeCalls.entries()) {
              if (call.from === disconnectedUserId || receiverId === disconnectedUserId) {
                if (call.timeoutId) {
                  clearTimeout(call.timeoutId);
                }
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
      });
    });
  });
}

module.exports = setupSocketHandlers;
