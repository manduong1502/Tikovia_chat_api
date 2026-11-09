const prisma = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const { deleteLocalFile } = require('../utils/storage');
const { sendNotificationHelper } = require('./pushController');

// Tạo cuộc trò chuyện mới (1v1 hoặc nhóm)
const createConversation = asyncHandler(async (req, res) => {
  const { name, isGroup, memberIds, userIds, avatarUrl } = req.body;
  const rawMemberIds = memberIds || userIds;
  const currentUserId = req.userId;

  if (!rawMemberIds || !Array.isArray(rawMemberIds) || rawMemberIds.length === 0) {
    return res.status(400).json({ error: 'Danh sách thành viên không hợp lệ' });
  }

  // Luôn bao gồm người tạo
  const allMemberIds = Array.from(new Set([currentUserId, ...rawMemberIds]));

  // Nếu là chat 1v1, kiểm tra xem đã tồn tại chưa
  if (!isGroup && allMemberIds.length === 2) {
    const otherUserId = allMemberIds.find((id) => id !== currentUserId);
    const existing = await prisma.conversation.findFirst({
      where: {
        isGroup: false,
        AND: [
          { members: { some: { userId: currentUserId } } },
          { members: { some: { userId: otherUserId } } }
        ]
      },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true,
                status: true,
                lastSeen: true
              }
            }
          }
        }
      }
    });

    if (existing) {
      return res.json(existing);
    }
  }

  // Tạo cuộc trò chuyện mới (Để avatarUrl = null nếu chưa tải ảnh để Avatar.jsx tự vẽ chữ cái đầu tức thì, không phụ thuộc mạng quốc tế dicebear.com)
  const conversation = await prisma.conversation.create({
    data: {
      name: isGroup ? (name || 'Nhóm mới').trim() : null,
      isGroup: Boolean(isGroup),
      avatarUrl: avatarUrl || null,
      createdById: currentUserId,
      members: {
        create: allMemberIds.map((userId) => ({
          userId,
          role: userId === currentUserId ? 'creator' : 'member'
        }))
      }
    },
    include: {
      members: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              status: true,
              lastSeen: true
            }
          }
        }
      }
    }
  });

  // Phát sự kiện realtime cho tất cả thành viên khi có cuộc hội thoại mới
  const io = req.app.get('io');
  if (io) {
    conversation.members.forEach((member) => {
      io.to(`user-${member.userId}`).emit('conversation-updated', {
        conversationId: conversation.id
      });
    });
  }

  // Nếu tạo nhóm mới, gửi thông báo đẩy (Web Push) cho các thành viên được thêm vào nhóm
  if (conversation.isGroup) {
    const creatorMember = conversation.members.find((m) => m.userId === currentUserId);
    const creatorName = creatorMember?.user?.displayName || 'Đồng nghiệp';
    const otherMembers = conversation.members.filter((m) => m.userId !== currentUserId);
    otherMembers.forEach((m) => {
      sendNotificationHelper(m.userId, {
        title: `👥 Nhóm mới: ${conversation.name || 'Nhóm chat'}`,
        body: `${creatorName} vừa thêm bạn vào nhóm "${conversation.name || 'Nhóm chat'}"`,
        icon: conversation.avatarUrl || '/pwa-192x192.png',
        conversationId: conversation.id,
        data: {
          url: '/',
          conversationId: conversation.id,
          type: 'group-added'
        }
      }).catch(() => {});
    });
  }

  res.status(201).json(conversation);
});

// Lấy danh sách cuộc trò chuyện của user kèm số tin nhắn chưa đọc (unreadCount) và trạng thái tắt thông báo (isMuted)
const getConversations = asyncHandler(async (req, res) => {
  const currentUserId = req.userId;

  const memberRecords = await prisma.conversationMember.findMany({
    where: { userId: currentUserId },
    select: {
      conversationId: true,
      lastReadAt: true,
      isMuted: true
    }
  });

  if (memberRecords.length === 0) {
    return res.json([]);
  }

  const conversationIds = memberRecords.map((c) => c.conversationId);
  const memberMetaMap = new Map(
    memberRecords.map((m) => [m.conversationId, { lastReadAt: m.lastReadAt, isMuted: m.isMuted }])
  );

  const conversations = await prisma.conversation.findMany({
    where: { id: { in: conversationIds } },
    include: {
      members: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              status: true,
              lastSeen: true
            }
          }
        }
      },
      messages: {
        where: {
          deletions: {
            none: {
              userId: currentUserId
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: {
          sender: {
            select: {
              id: true,
              displayName: true
            }
          }
        }
      }
    },
    orderBy: { updatedAt: 'desc' }
  });

  // Tính toán số lượng tin nhắn chưa đọc cho TẤT CẢ hội thoại chỉ bằng 1 câu truy vấn SQL duy nhất (Khử triệt để bài toán N+1 Query)
  const unreadRows = await prisma.$queryRaw`
    SELECT m."conversationId", COUNT(*)::int AS "unreadCount"
    FROM "Message" m
    INNER JOIN "ConversationMember" cm
      ON cm."conversationId" = m."conversationId"
      AND cm."userId" = ${currentUserId}
    WHERE m."createdAt" > cm."lastReadAt"
      AND m."senderId" != ${currentUserId}
      AND m."isRecalled" = false
      AND NOT EXISTS (
        SELECT 1 FROM "MessageDeletion" md
        WHERE md."messageId" = m."id"
          AND md."userId" = ${currentUserId}
      )
    GROUP BY m."conversationId"
  `;

  const unreadMap = new Map(
    (unreadRows || []).map((row) => [row.conversationId, Number(row.unreadCount) || 0])
  );

  const enrichedConversations = conversations.map((conv) => {
    const meta = memberMetaMap.get(conv.id) || { lastReadAt: new Date(0), isMuted: false };
    return {
      ...conv,
      unreadCount: unreadMap.get(conv.id) || 0,
      isMuted: Boolean(meta.isMuted),
      lastReadAt: meta.lastReadAt
    };
  });

  res.json(enrichedConversations);
});

// Lấy lịch sử tin nhắn
const getMessages = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  const currentUserId = req.userId;

  const isMember = await prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: {
        conversationId,
        userId: currentUserId
      }
    }
  });

  if (!isMember) {
    return res.status(403).json({ error: 'Bạn không có quyền truy cập cuộc trò chuyện này' });
  }

  const limitVal = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const beforeId = req.query.before;
  const searchQuery = req.query.search ? String(req.query.search).trim() : '';

  const queryOptions = {
    where: {
      conversationId,
      deletions: {
        none: {
          userId: currentUserId
        }
      },
      ...(searchQuery
        ? {
            isRecalled: false,
            type: 'text',
            content: {
              contains: searchQuery,
              mode: 'insensitive'
            }
          }
        : {})
    },
    take: searchQuery ? 100 : limitVal,
    orderBy: { createdAt: 'desc' },
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
  };

  if (beforeId && !searchQuery) {
    queryOptions.cursor = { id: beforeId };
    queryOptions.skip = 1;
  }

  const messages = await prisma.message.findMany(queryOptions);

  // Khi mở xem tin nhắn mới nhất của cuộc hội thoại, tự động đánh dấu đã đọc
  if (!beforeId && !searchQuery) {
    prisma.conversationMember
      .update({
        where: {
          conversationId_userId: {
            conversationId,
            userId: currentUserId
          }
        },
        data: { lastReadAt: new Date() }
      })
      .catch(() => {});
  }

  res.json(messages.reverse());
});

// Đánh dấu cuộc trò chuyện đã đọc
const markConversationRead = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  const currentUserId = req.userId;

  const member = await prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: {
        conversationId,
        userId: currentUserId
      }
    }
  });

  if (!member) {
    return res.status(403).json({ error: 'Bạn không phải thành viên cuộc trò chuyện này' });
  }

  const now = new Date();
  await prisma.conversationMember.update({
    where: {
      conversationId_userId: {
        conversationId,
        userId: currentUserId
      }
    },
    data: { lastReadAt: now }
  });

  res.json({ success: true, conversationId, lastReadAt: now });
});

// Bật / Tắt thông báo cho từng cuộc hội thoại
const toggleMuteConversation = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  const currentUserId = req.userId;

  const member = await prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: {
        conversationId,
        userId: currentUserId
      }
    }
  });

  if (!member) {
    return res.status(403).json({ error: 'Bạn không phải thành viên cuộc trò chuyện này' });
  }

  const nextMutedState = typeof req.body?.isMuted === 'boolean' ? req.body.isMuted : !member.isMuted;

  const updated = await prisma.conversationMember.update({
    where: {
      conversationId_userId: {
        conversationId,
        userId: currentUserId
      }
    },
    data: { isMuted: nextMutedState }
  });

  res.json({
    message: updated.isMuted ? 'Đã tắt thông báo cuộc trò chuyện' : 'Đã bật thông báo cuộc trò chuyện',
    conversationId,
    isMuted: updated.isMuted
  });
});

// Đổi biệt danh của thành viên trong đoạn chat
const setNickname = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  const { targetUserId, nickname } = req.body;
  const currentUserId = req.userId;

  const isMember = await prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: {
        conversationId,
        userId: currentUserId
      }
    }
  });

  if (!isMember) {
    return res.status(403).json({ error: 'Không có quyền thực hiện thao tác này' });
  }

  const updatedMember = await prisma.conversationMember.update({
    where: {
      conversationId_userId: {
        conversationId,
        userId: targetUserId
      }
    },
    data: { nickname: nickname ? String(nickname).trim() : null }
  });

  const io = req.app.get('io');
  if (io) {
    const members = await prisma.conversationMember.findMany({
      where: { conversationId },
      select: { userId: true }
    });
    members.forEach((m) => {
      io.to(`user-${m.userId}`).emit('conversation-updated', { conversationId });
    });
  }

  res.json({ message: 'Đổi biệt danh thành công', member: updatedMember });
});

// Ghim / Bỏ ghim tin nhắn
const togglePinMessage = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const currentUserId = req.userId;

  const message = await prisma.message.findUnique({
    where: { id: messageId }
  });

  if (!message) {
    return res.status(404).json({ error: 'Không tìm thấy tin nhắn' });
  }

  const isMember = await prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: {
        conversationId: message.conversationId,
        userId: currentUserId
      }
    }
  });

  if (!isMember) {
    return res.status(403).json({ error: 'Bạn không có quyền ghim tin nhắn trong cuộc trò chuyện này' });
  }

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: {
      isPinned: !message.isPinned,
      pinnedBy: !message.isPinned ? currentUserId : null,
      pinnedAt: !message.isPinned ? new Date() : null
    },
    include: {
      sender: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
          username: true
        }
      }
    }
  });

  const io = req.app.get('io');
  if (io) {
    const members = await prisma.conversationMember.findMany({
      where: { conversationId: message.conversationId },
      select: { userId: true }
    });
    members.forEach((m) => {
      io.to(`user-${m.userId}`).emit('message-pinned', updated);
    });
  }

  res.json({
    message: updated.isPinned ? 'Đã ghim tin nhắn' : 'Đã bỏ ghim tin nhắn',
    chatMessage: updated
  });
});

// Tạo nhắc hẹn (Hỗ trợ tạo trực tiếp trong cuộc trò chuyện kèm tin nhắn loại 'reminder')
const createReminder = asyncHandler(async (req, res) => {
  const { conversationId, messageId, title, remindAt, replyToId } = req.body;
  const currentUserId = req.userId;

  if (!title || !String(title).trim() || !remindAt) {
    return res.status(400).json({ error: 'Vui lòng điền đầy đủ tiêu đề và thời gian hẹn' });
  }

  const parsedDate = new Date(remindAt);
  if (Number.isNaN(parsedDate.getTime())) {
    return res.status(400).json({ error: 'Thời gian nhắc hẹn không hợp lệ' });
  }

  let targetConversationId = conversationId || null;
  let existingMessage = null;

  // Nếu gửi kèm messageId thật (không phải mock id cũ), kiểm tra tin nhắn đó
  if (messageId && messageId !== 'reminder_mock_id') {
    existingMessage = await prisma.message.findUnique({
      where: { id: messageId }
    });
    if (!existingMessage && !targetConversationId) {
      return res.status(404).json({ error: 'Không tìm thấy tin nhắn hoặc cuộc hội thoại liên quan' });
    }
    if (existingMessage && !targetConversationId) {
      targetConversationId = existingMessage.conversationId;
    }
  }

  if (!targetConversationId) {
    return res.status(400).json({ error: 'Thiếu mã cuộc trò chuyện (conversationId)' });
  }

  const isMember = await prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: {
        conversationId: targetConversationId,
        userId: currentUserId
      }
    }
  });

  if (!isMember) {
    return res.status(403).json({ error: 'Bạn không có quyền tạo nhắc hẹn trong cuộc trò chuyện này' });
  }

  const cleanTitle = String(title).trim();

  const { reminder, createdMessage } = await prisma.$transaction(async (tx) => {
    let msgRecord = existingMessage;

    if (!msgRecord) {
      msgRecord = await tx.message.create({
        data: {
          conversationId: targetConversationId,
          senderId: currentUserId,
          type: 'reminder',
          content: cleanTitle,
          metadata: JSON.stringify({
            remindAt: parsedDate.toISOString(),
            title: cleanTitle
          }),
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
          reactions: true
        }
      });

      await tx.conversation.update({
        where: { id: targetConversationId },
        data: { updatedAt: new Date() }
      });
    }

    const rem = await tx.reminder.create({
      data: {
        conversationId: targetConversationId,
        messageId: msgRecord.id,
        creatorId: currentUserId,
        title: cleanTitle,
        remindAt: parsedDate,
        status: 'pending'
      }
    });

    return { reminder: rem, createdMessage: existingMessage ? null : msgRecord };
  });

  // Phát sự kiện tin nhắn nhắc hẹn mới cho toàn bộ thành viên trong hội thoại
  const io = req.app.get('io');
  if (io && createdMessage) {
    const members = await prisma.conversationMember.findMany({
      where: { conversationId: targetConversationId },
      select: { userId: true }
    });
    members.forEach((m) => {
      io.to(`user-${m.userId}`).emit('receive-message', createdMessage);
    });
  }

  res.status(201).json({
    ...reminder,
    chatMessage: createdMessage
  });
});

// Lấy kho dữ liệu media (Ảnh, File, Link) của cuộc hội thoại
const getMediaGallery = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  const currentUserId = req.userId;

  const isMember = await prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: {
        conversationId,
        userId: currentUserId
      }
    }
  });

  if (!isMember) {
    return res.status(403).json({ error: 'Không có quyền truy cập' });
  }

  const messages = await prisma.message.findMany({
    where: {
      conversationId,
      isRecalled: false,
      deletions: {
        none: {
          userId: currentUserId
        }
      },
      type: { in: ['image', 'file', 'text'] }
    },
    select: {
      id: true,
      type: true,
      content: true,
      createdAt: true,
      metadata: true,
      sender: {
        select: {
          displayName: true
        }
      }
    },
    orderBy: { createdAt: 'desc' },
    take: 300
  });

  const images = [];
  const files = [];
  const links = [];

  const urlRegex = /(https?:\/\/[^\s]+)/gi;

  messages.forEach((msg) => {
    if (!msg.content) return;

    if (msg.type === 'image') {
      images.push({
        id: msg.id,
        url: msg.content,
        createdAt: msg.createdAt,
        senderName: msg.sender ? msg.sender.displayName : 'Hệ thống'
      });
    } else if (msg.type === 'file') {
      let meta = {};
      try {
        if (msg.metadata) meta = JSON.parse(msg.metadata);
      } catch (e) {}

      const rawFileName = meta.fileName || msg.content.substring(msg.content.lastIndexOf('/') + 1);
      const cleanFileName = meta.fileName ? meta.fileName : rawFileName.replace(/^\d+-[a-f0-9]+-?/i, '');

      files.push({
        id: msg.id,
        url: msg.content,
        name: cleanFileName || 'Tệp đính kèm',
        size: meta.fileSize,
        mimeType: meta.mimeType,
        createdAt: msg.createdAt,
        senderName: msg.sender ? msg.sender.displayName : 'Hệ thống'
      });
    } else if (msg.type === 'text') {
      const urlsFound = msg.content.match(urlRegex);
      if (urlsFound) {
        urlsFound.forEach((url) => {
          links.push({
            id: msg.id,
            url,
            createdAt: msg.createdAt,
            senderName: msg.sender ? msg.sender.displayName : 'Hệ thống'
          });
        });
      }
    }
  });

  res.json({ images, files, links });
});

// Xóa tin nhắn phía tôi
const deleteMessageForMe = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const currentUserId = req.userId;

  const message = await prisma.message.findUnique({
    where: { id: messageId }
  });

  if (!message) {
    return res.status(404).json({ error: 'Không tìm thấy tin nhắn' });
  }

  const isMember = await prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: {
        conversationId: message.conversationId,
        userId: currentUserId
      }
    }
  });

  if (!isMember) {
    return res.status(403).json({ error: 'Không có quyền thực hiện thao tác này' });
  }

  await prisma.messageDeletion.upsert({
    where: {
      messageId_userId: {
        messageId,
        userId: currentUserId
      }
    },
    update: {},
    create: {
      messageId,
      userId: currentUserId
    }
  });

  res.json({ message: 'Đã xóa tin nhắn đối với bạn', messageId });
});

// Thêm thành viên vào nhóm (Hỗ trợ cả memberIds và userIds từ client)
const addGroupMembers = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  const rawMemberIds = req.body.memberIds || req.body.userIds;
  const currentUserId = req.userId;

  if (!rawMemberIds || !Array.isArray(rawMemberIds) || rawMemberIds.length === 0) {
    return res.status(400).json({ error: 'Danh sách thành viên không hợp lệ' });
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      members: true
    }
  });

  if (!conversation) {
    return res.status(404).json({ error: 'Không tìm thấy cuộc hội thoại' });
  }

  if (!conversation.isGroup) {
    return res.status(400).json({ error: 'Không thể thêm thành viên vào cuộc trò chuyện cá nhân' });
  }

  const isMember = conversation.members.some((m) => m.userId === currentUserId);
  if (!isMember) {
    return res.status(403).json({ error: 'Bạn không có quyền thực hiện thao tác này' });
  }

  const existingUserIds = new Set(conversation.members.map((m) => m.userId));
  const newMemberIds = Array.from(new Set(rawMemberIds)).filter((id) => !existingUserIds.has(id));

  if (newMemberIds.length === 0) {
    return res.status(400).json({ error: 'Tất cả thành viên được chọn đã ở trong nhóm' });
  }

  await prisma.conversationMember.createMany({
    data: newMemberIds.map((userId) => ({
      conversationId,
      userId,
      role: 'member'
    })),
    skipDuplicates: true
  });

  const newUsers = await prisma.user.findMany({
    where: { id: { in: newMemberIds } },
    select: { displayName: true }
  });
  const newNames = newUsers.map((u) => u.displayName);

  const currentUser = await prisma.user.findUnique({
    where: { id: currentUserId },
    select: { displayName: true }
  });

  const systemContent = `${currentUser?.displayName || 'Thành viên'} đã thêm ${newNames.join(', ')} vào nhóm`;
  const systemMsg = await prisma.message.create({
    data: {
      conversationId,
      senderId: currentUserId,
      type: 'text',
      content: systemContent
    },
    include: {
      sender: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
          username: true
        }
      }
    }
  });

  const updatedConv = await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
    include: {
      members: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              status: true,
              lastSeen: true
            }
          }
        }
      }
    }
  });

  const io = req.app.get('io');
  if (io) {
    updatedConv.members.forEach((member) => {
      io.to(`user-${member.userId}`).emit('receive-message', systemMsg);
      io.to(`user-${member.userId}`).emit('conversation-updated', { conversationId });
    });
  }

  // Gửi Web Push thông báo cho các thành viên mới được thêm vào nhóm
  newMemberIds.forEach((newUserId) => {
    sendNotificationHelper(newUserId, {
      title: `👥 ${updatedConv.name || 'Nhóm chat'}`,
      body: `${currentUser?.displayName || 'Thành viên'} vừa thêm bạn vào nhóm`,
      icon: updatedConv.avatarUrl || '/pwa-192x192.png',
      conversationId,
      data: {
        url: '/',
        conversationId,
        type: 'group-added'
      }
    }).catch(() => {});
  });

  res.status(200).json(updatedConv);
});

// Xóa thành viên hoặc rời nhóm (Có tự động chuyển quyền Trưởng nhóm nếu người tạo rời nhóm)
const removeGroupMember = asyncHandler(async (req, res) => {
  const { conversationId, userId } = req.params;
  const currentUserId = req.userId;

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      members: true
    }
  });

  if (!conversation) {
    return res.status(404).json({ error: 'Không tìm thấy cuộc hội thoại' });
  }

  if (!conversation.isGroup) {
    return res.status(400).json({ error: 'Thao tác chỉ áp dụng cho nhóm chat' });
  }

  const targetMember = conversation.members.find((m) => m.userId === userId);
  if (!targetMember) {
    return res.status(400).json({ error: 'Người dùng không phải thành viên nhóm này' });
  }

  const isSelf = userId === currentUserId;
  const isCreator = conversation.createdById === currentUserId;

  if (!isSelf && !isCreator) {
    return res.status(403).json({ error: 'Chỉ Trưởng nhóm mới có quyền xóa thành viên' });
  }

  await prisma.conversationMember.delete({
    where: {
      conversationId_userId: {
        conversationId,
        userId
      }
    }
  });

  const remainingMembers = conversation.members
    .filter((m) => m.userId !== userId)
    .sort((a, b) => new Date(a.joinedAt) - new Date(b.joinedAt));

  // Nếu không còn thành viên nào trong nhóm, xóa nhóm
  if (remainingMembers.length === 0) {
    await prisma.conversation.delete({ where: { id: conversationId } });
    const io = req.app.get('io');
    if (io) {
      io.to(`user-${userId}`).emit('conversation-removed', { conversationId });
    }
    return res.status(200).json({ deleted: true, conversationId });
  }

  // Nếu Trưởng nhóm tự rời nhóm, chuyển quyền Trưởng nhóm cho thành viên lâu năm nhất còn lại
  let nextCreatorId = conversation.createdById;
  if (isSelf && isCreator) {
    nextCreatorId = remainingMembers[0].userId;
    await prisma.conversationMember.update({
      where: {
        conversationId_userId: {
          conversationId,
          userId: nextCreatorId
        }
      },
      data: { role: 'creator' }
    });
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { displayName: true }
  });
  const currentUser = await prisma.user.findUnique({
    where: { id: currentUserId },
    select: { displayName: true }
  });

  const systemContent = isSelf
    ? `${targetUser?.displayName || 'Thành viên'} đã rời khỏi nhóm`
    : `${currentUser?.displayName || 'Trưởng nhóm'} đã mời ${targetUser?.displayName || 'thành viên'} ra khỏi nhóm`;

  const systemMsg = await prisma.message.create({
    data: {
      conversationId,
      senderId: currentUserId,
      type: 'text',
      content: systemContent
    },
    include: {
      sender: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
          username: true
        }
      }
    }
  });

  const updatedConv = await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      createdById: nextCreatorId,
      updatedAt: new Date()
    },
    include: {
      members: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              status: true,
              lastSeen: true
            }
          }
        }
      }
    }
  });

  const io = req.app.get('io');
  if (io) {
    const allMemberIds = [userId, ...updatedConv.members.map((m) => m.userId)];
    allMemberIds.forEach((mId) => {
      io.to(`user-${mId}`).emit('receive-message', systemMsg);
      io.to(`user-${mId}`).emit('conversation-updated', { conversationId });
    });
    io.to(`user-${userId}`).emit('conversation-removed', { conversationId });
  }

  res.status(200).json(updatedConv);
});

const updateGroupDetails = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  const { name, avatarUrl } = req.body;
  const currentUserId = req.userId;

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      members: true
    }
  });

  if (!conversation) {
    return res.status(404).json({ error: 'Không tìm thấy cuộc hội thoại' });
  }

  if (!conversation.isGroup) {
    return res.status(400).json({ error: 'Thao tác chỉ áp dụng cho nhóm chat' });
  }

  const isCreator = conversation.createdById === currentUserId;
  if (!isCreator) {
    return res.status(403).json({ error: 'Chỉ Trưởng nhóm mới có quyền sửa đổi thông tin nhóm' });
  }

  // Nếu thay đổi ảnh đại diện nhóm và ảnh cũ nằm trên SSD cục bộ, xóa ảnh cũ để tiết kiệm dung lượng
  if (avatarUrl && conversation.avatarUrl && avatarUrl !== conversation.avatarUrl) {
    deleteLocalFile(conversation.avatarUrl).catch(() => {});
  }

  const updatedConv = await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      name: name ? String(name).trim() : undefined,
      avatarUrl: avatarUrl || undefined,
      updatedAt: new Date()
    },
    include: {
      members: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
              status: true,
              lastSeen: true
            }
          }
        }
      }
    }
  });

  const currentUser = await prisma.user.findUnique({
    where: { id: currentUserId },
    select: { displayName: true }
  });

  let systemContent = `${currentUser?.displayName || 'Trưởng nhóm'} đã cập nhật thông tin nhóm`;
  if (name && name !== conversation.name && avatarUrl && avatarUrl !== conversation.avatarUrl) {
    systemContent = `${currentUser?.displayName} đã đổi tên nhóm thành "${name}" và thay đổi ảnh đại diện nhóm`;
  } else if (name && name !== conversation.name) {
    systemContent = `${currentUser?.displayName} đã đổi tên nhóm thành "${name}"`;
  } else if (avatarUrl && avatarUrl !== conversation.avatarUrl) {
    systemContent = `${currentUser?.displayName} đã thay đổi ảnh đại diện nhóm`;
  }

  const systemMsg = await prisma.message.create({
    data: {
      conversationId,
      senderId: currentUserId,
      type: 'text',
      content: systemContent
    },
    include: {
      sender: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
          username: true
        }
      }
    }
  });

  const io = req.app.get('io');
  if (io) {
    updatedConv.members.forEach((member) => {
      io.to(`user-${member.userId}`).emit('receive-message', systemMsg);
      io.to(`user-${member.userId}`).emit('conversation-updated', { conversationId });
    });
  }

  res.status(200).json(updatedConv);
});

module.exports = {
  createConversation,
  getConversations,
  getMessages,
  markConversationRead,
  toggleMuteConversation,
  setNickname,
  togglePinMessage,
  createReminder,
  getMediaGallery,
  deleteMessageForMe,
  addGroupMembers,
  removeGroupMember,
  updateGroupDetails
};
