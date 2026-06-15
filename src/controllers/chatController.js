const prisma = require('../db');
const asyncHandler = require('../utils/asyncHandler');

// Tạo cuộc trò chuyện mới (1v1 hoặc nhóm)
const createConversation = asyncHandler(async (req, res) => {
  const { name, isGroup, memberIds, avatarUrl } = req.body;
  const currentUserId = req.userId;

  if (!memberIds || !Array.isArray(memberIds) || memberIds.length === 0) {
    return res.status(400).json({ error: 'Danh sách thành viên không hợp lệ' });
  }

  // Luôn bao gồm người tạo
  const allMemberIds = Array.from(new Set([currentUserId, ...memberIds]));

  // Nếu là chat 1v1, kiểm tra xem đã tồn tại chưa
  if (!isGroup && allMemberIds.length === 2) {
    const otherUserId = allMemberIds.find(id => id !== currentUserId);
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
                status: true
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

  // Tạo cuộc trò chuyện mới
  const defaultAvatar = isGroup
    ? `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name || 'Group')}`
    : undefined;

  const conversation = await prisma.conversation.create({
    data: {
      name: isGroup ? name : null,
      isGroup,
      avatarUrl: avatarUrl || defaultAvatar,
      createdById: currentUserId,
      members: {
        create: allMemberIds.map(userId => ({
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
              status: true
            }
          }
        }
      }
    }
  });

  res.status(201).json(conversation);
});

// Lấy danh sách cuộc trò chuyện của user
const getConversations = asyncHandler(async (req, res) => {
  const currentUserId = req.userId;

  const memberConversations = await prisma.conversationMember.findMany({
    where: { userId: currentUserId },
    select: { conversationId: true }
  });

  const conversationIds = memberConversations.map(c => c.conversationId);

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

  res.json(conversations);
});

// Lấy lịch sử tin nhắn
const getMessages = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  const currentUserId = req.userId;

  // Kiểm tra xem user có phải thành viên không
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

  const limitVal = req.query.limit ? parseInt(req.query.limit, 10) : 50;
  const beforeId = req.query.before;
  const searchQuery = req.query.search;

  const queryOptions = {
    where: {
      conversationId,
      deletions: {
        none: {
          userId: currentUserId
        }
      },
      ...(searchQuery ? {
        type: 'text',
        content: {
          contains: searchQuery
        }
      } : {})
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

  // Đảo ngược mảng tin nhắn để trả về theo thứ tự thời gian tăng dần (cũ đến mới) cho client hiển thị
  res.json(messages.reverse());
});

// Đổi biệt danh của thành viên trong đoạn chat
const setNickname = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  const { targetUserId, nickname } = req.body;
  const currentUserId = req.userId;

  // Kiểm tra xem current user có trong nhóm không
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
    data: { nickname }
  });

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

  // Kiểm tra xem người dùng có thuộc cuộc hội thoại của tin nhắn này hay không
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
    }
  });

  res.json({
    message: updated.isPinned ? 'Đã ghim tin nhắn' : 'Đã bỏ ghim tin nhắn',
    chatMessage: updated
  });
});

// Tạo nhắc hẹn
const createReminder = asyncHandler(async (req, res) => {
  const { messageId, title, remindAt } = req.body;
  const currentUserId = req.userId;

  if (!title || !remindAt) {
    return res.status(400).json({ error: 'Vui lòng điền đầy đủ tiêu đề và thời gian hẹn' });
  }

  // Kiểm tra xem messageId có hợp lệ và người dùng có quyền truy cập cuộc hội thoại không
  if (messageId) {
    const message = await prisma.message.findUnique({
      where: { id: messageId }
    });

    if (!message) {
      return res.status(404).json({ error: 'Không tìm thấy tin nhắn liên quan' });
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
      return res.status(403).json({ error: 'Bạn không có quyền tạo nhắc hẹn trong cuộc trò chuyện này' });
    }
  }

  const reminder = await prisma.reminder.create({
    data: {
      messageId,
      creatorId: currentUserId,
      title,
      remindAt: new Date(remindAt),
      status: 'pending'
    }
  });

  res.status(201).json(reminder);
});

// Lấy kho dữ liệu media (Ảnh, File, Link) của cuộc hội thoại
const getMediaGallery = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  const currentUserId = req.userId;

  // Kiểm tra xem user có phải thành viên không
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
      type: { in: ['image', 'file', 'text'] } // text để lọc lấy link
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
    orderBy: { createdAt: 'desc' }
  });

  const images = [];
  const files = [];
  const links = [];

  // RegExp tìm các URL trong tin nhắn văn bản
  const urlRegex = /(https?:\/\/[^\s]+)/gi;

  messages.forEach(msg => {
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

      files.push({
        id: msg.id,
        url: msg.content,
        name: msg.content.substring(msg.content.lastIndexOf('/') + 1),
        size: meta.fileSize,
        mimeType: meta.mimeType,
        createdAt: msg.createdAt,
        senderName: msg.sender ? msg.sender.displayName : 'Hệ thống'
      });
    } else if (msg.type === 'text') {
      const urlsFound = msg.content.match(urlRegex);
      if (urlsFound) {
        urlsFound.forEach(url => {
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

  // Kiểm tra xem người dùng có trong cuộc hội thoại của tin nhắn này không
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

  // Thêm bản ghi xóa tin nhắn
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

module.exports = {
  createConversation,
  getConversations,
  getMessages,
  setNickname,
  togglePinMessage,
  createReminder,
  getMediaGallery,
  deleteMessageForMe
};
