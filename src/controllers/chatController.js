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

      const rawFileName = meta.fileName || msg.content.substring(msg.content.lastIndexOf('/') + 1);
      const cleanFileName = rawFileName.replace(/^\d+-/, '');

      files.push({
        id: msg.id,
        url: msg.content,
        name: cleanFileName,
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

const addGroupMembers = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  const { memberIds } = req.body; // Array of user IDs to add
  const currentUserId = req.userId;

  if (!memberIds || !Array.isArray(memberIds) || memberIds.length === 0) {
    return res.status(400).json({ error: 'Danh sách thành viên không hợp lệ' });
  }

  // Lấy thông tin nhóm
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

  // Kiểm tra user hiện tại có phải thành viên nhóm không
  const isMember = conversation.members.some(m => m.userId === currentUserId);
  if (!isMember) {
    return res.status(403).json({ error: 'Bạn không có quyền thực hiện thao tác này' });
  }

  // Lọc ra các thành viên chưa có trong nhóm
  const existingUserIds = conversation.members.map(m => m.userId);
  const newMemberIds = memberIds.filter(id => !existingUserIds.includes(id));

  if (newMemberIds.length === 0) {
    return res.status(400).json({ error: 'Tất cả thành viên được chọn đã ở trong nhóm' });
  }

  // Thêm thành viên mới vào DB
  await prisma.conversationMember.createMany({
    data: newMemberIds.map(userId => ({
      conversationId,
      userId,
      role: 'member'
    }))
  });

  // Lấy tên các thành viên mới
  const newUsers = await prisma.user.findMany({
    where: { id: { in: newMemberIds } },
    select: { displayName: true }
  });
  const newNames = newUsers.map(u => u.displayName);

  // Lấy tên người thêm
  const currentUser = await prisma.user.findUnique({
    where: { id: currentUserId },
    select: { displayName: true }
  });

  // Tạo tin nhắn hệ thống thông báo thêm thành viên
  const systemContent = `${currentUser.displayName} đã thêm ${newNames.join(', ')} vào nhóm`;
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

  // Cập nhật updatedAt của cuộc hội thoại
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

  // Gửi real-time socket
  const io = req.app.get('io');
  if (io) {
    // Gửi tin nhắn mới tới toàn bộ thành viên cũ + mới
    const allMembers = updatedConv.members;
    allMembers.forEach(member => {
      io.to(`user-${member.userId}`).emit('receive-message', systemMsg);
    });
    // Phát sự kiện cập nhật chỉ cho members (bao gồm cả thành viên mới)
    allMembers.forEach(member => {
      io.to(`user-${member.userId}`).emit('conversation-updated', { conversationId });
    });
  }

  res.status(200).json(updatedConv);
});

const removeGroupMember = asyncHandler(async (req, res) => {
  const { conversationId, userId } = req.params;
  const currentUserId = req.userId;

  // Lấy thông tin nhóm
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

  // Tìm thành viên cần mời ra hoặc tự rời
  const targetMember = conversation.members.find(m => m.userId === userId);
  if (!targetMember) {
    return res.status(400).json({ error: 'Người dùng không phải thành viên nhóm này' });
  }

  const isSelf = userId === currentUserId;
  const isCreator = conversation.createdById === currentUserId;

  // Quyền hạn: Chỉ người tạo nhóm được kick người khác, tự rời nhóm thì ai cũng được
  if (!isSelf && !isCreator) {
    return res.status(403).json({ error: 'Chỉ Trưởng nhóm mới có quyền xóa thành viên' });
  }

  // Thực hiện xóa khỏi DB
  await prisma.conversationMember.delete({
    where: {
      conversationId_userId: {
        conversationId,
        userId
      }
    }
  });

  // Lấy thông tin người bị mời/rời và người mời
  const targetUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { displayName: true }
  });
  const currentUser = await prisma.user.findUnique({
    where: { id: currentUserId },
    select: { displayName: true }
  });

  // Tạo tin nhắn thông báo rời/bị mời ra khỏi nhóm
  const systemContent = isSelf
    ? `${targetUser.displayName} đã rời khỏi nhóm`
    : `${currentUser.displayName} đã mời ${targetUser.displayName} ra khỏi nhóm`;

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

  // Cập nhật updatedAt của cuộc hội thoại
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

  // Gửi real-time socket
  const io = req.app.get('io');
  if (io) {
    // Gửi tin nhắn mới tới thành viên cũ (kể cả người vừa bị xóa để cập nhật giao diện)
    const allMemberIds = [userId, ...updatedConv.members.map(m => m.userId)];
    allMemberIds.forEach(mId => {
      io.to(`user-${mId}`).emit('receive-message', systemMsg);
    });
    // Gửi thông báo người dùng đã bị mời ra khỏi phòng chat
    io.to(`user-${userId}`).emit('conversation-removed', { conversationId });
    // Phát cập nhật chỉ cho members còn lại + người bị xóa
    const allNotifyIds = [userId, ...updatedConv.members.map(m => m.userId)];
    allNotifyIds.forEach(mId => {
      io.to(`user-${mId}`).emit('conversation-updated', { conversationId });
    });
  }

  res.status(200).json(updatedConv);
});

const updateGroupDetails = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  const { name, avatarUrl } = req.body;
  const currentUserId = req.userId;

  // Lấy thông tin nhóm
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

  // Kiểm tra quyền hạn: Chỉ người tạo nhóm được sửa
  const isCreator = conversation.createdById === currentUserId;
  if (!isCreator) {
    return res.status(403).json({ error: 'Chỉ Trưởng nhóm mới có quyền sửa đổi thông tin nhóm' });
  }

  // Cập nhật thông tin nhóm
  const updatedConv = await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      name: name || undefined,
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

  // Lấy thông tin người sửa
  const currentUser = await prisma.user.findUnique({
    where: { id: currentUserId },
    select: { displayName: true }
  });

  // Tạo tin nhắn hệ thống thông báo thay đổi thông tin nhóm
  let systemContent = `${currentUser.displayName} đã cập nhật thông tin nhóm`;
  if (name && name !== conversation.name && avatarUrl && avatarUrl !== conversation.avatarUrl) {
    systemContent = `${currentUser.displayName} đã đổi tên nhóm thành "${name}" và thay đổi ảnh đại diện nhóm`;
  } else if (name && name !== conversation.name) {
    systemContent = `${currentUser.displayName} đã đổi tên nhóm thành "${name}"`;
  } else if (avatarUrl && avatarUrl !== conversation.avatarUrl) {
    systemContent = `${currentUser.displayName} đã thay đổi ảnh đại diện nhóm`;
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

  // Gửi real-time socket
  const io = req.app.get('io');
  if (io) {
    updatedConv.members.forEach(member => {
      io.to(`user-${member.userId}`).emit('receive-message', systemMsg);
    });
    updatedConv.members.forEach(member => {
      io.to(`user-${member.userId}`).emit('conversation-updated', { conversationId });
    });
  }

  res.status(200).json(updatedConv);
});

module.exports = {
  createConversation,
  getConversations,
  getMessages,
  setNickname,
  togglePinMessage,
  createReminder,
  getMediaGallery,
  deleteMessageForMe,
  addGroupMembers,
  removeGroupMember,
  updateGroupDetails
};
