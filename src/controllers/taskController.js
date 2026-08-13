const prisma = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');

// Tạo công việc mới
const createTask = asyncHandler(async (req, res) => {
  const { title, description, assigneeId, dueDate, conversationId } = req.body;
  const assignerId = req.userId;

  if (!title || !assigneeId || !conversationId) {
    return res.status(400).json({ error: 'Thiếu thông tin công việc bắt buộc' });
  }

  // 1. Kiểm tra quyền của người giao việc (phải là thành viên phòng chat)
  const isAssignerMember = await prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: {
        conversationId,
        userId: assignerId
      }
    }
  });

  if (!isAssignerMember) {
    return res.status(403).json({ error: 'Bạn không có quyền giao việc trong phòng chat này' });
  }

  // 2. Kiểm tra người nhận việc (phải là thành viên phòng chat)
  const isAssigneeMember = await prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: {
        conversationId,
        userId: assigneeId
      }
    }
  });

  if (!isAssigneeMember) {
    return res.status(400).json({ error: 'Người nhận việc không thuộc phòng chat này' });
  }

  // 3. Sử dụng transaction để tạo Task và Message đồng bộ
  const result = await prisma.$transaction(async (tx) => {
    // Tạo Task trước
    const task = await tx.task.create({
      data: {
        title,
        description: description || null,
        dueDate: dueDate ? new Date(dueDate) : null,
        status: 'pending',
        assignerId,
        assigneeId,
        conversationId
      },
      include: {
        assignee: {
          select: {
            id: true,
            displayName: true,
            avatarUrl: true
          }
        },
        assigner: {
          select: {
            id: true,
            displayName: true,
            avatarUrl: true
          }
        }
      }
    });

    // Tạo tin nhắn thông báo dạng 'task'
    const message = await tx.message.create({
      data: {
        conversationId,
        senderId: assignerId,
        type: 'task',
        content: title,
        metadata: JSON.stringify({
          taskId: task.id,
          title,
          description: description || '',
          assigneeId,
          assigneeName: task.assignee.displayName,
          dueDate: dueDate || null,
          status: 'pending'
        })
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

    // Cập nhật lại Task để lưu liên kết messageId
    const updatedTask = await tx.task.update({
      where: { id: task.id },
      data: { messageId: message.id },
      include: {
        assignee: {
          select: { id: true, displayName: true, avatarUrl: true }
        },
        assigner: {
          select: { id: true, displayName: true, avatarUrl: true }
        }
      }
    });

    return { task: updatedTask, message };
  });

  // 4. Phát tin nhắn real-time tới tất cả thành viên trong nhóm
  const io = req.app.get('io');
  if (io) {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { members: true }
    });
    if (conv) {
      conv.members.forEach(member => {
        io.to(`user-${member.userId}`).emit('receive-message', result.message);
      });
      conv.members.forEach(member => {
        io.to(`user-${member.userId}`).emit('conversation-updated', { conversationId });
      });
    }
  }

  res.status(201).json(result.task);
});

// Lấy danh sách công việc của bản thân
const getTasks = asyncHandler(async (req, res) => {
  const currentUserId = req.userId;

  const assignedToMe = await prisma.task.findMany({
    where: { assigneeId: currentUserId },
    include: {
      assigner: {
        select: { id: true, displayName: true, avatarUrl: true }
      },
      assignee: {
        select: { id: true, displayName: true, avatarUrl: true }
      },
      conversation: {
        select: {
          id: true,
          name: true,
          isGroup: true,
          members: {
            include: {
              user: { select: { id: true, displayName: true } }
            }
          }
        }
      }
    },
    orderBy: { createdAt: 'desc' }
  });

  const assignedByMe = await prisma.task.findMany({
    where: { assignerId: currentUserId },
    include: {
      assigner: {
        select: { id: true, displayName: true, avatarUrl: true }
      },
      assignee: {
        select: { id: true, displayName: true, avatarUrl: true }
      },
      conversation: {
        select: {
          id: true,
          name: true,
          isGroup: true,
          members: {
            include: {
              user: { select: { id: true, displayName: true } }
            }
          }
        }
      }
    },
    orderBy: { createdAt: 'desc' }
  });

  res.status(200).json({ assignedToMe, assignedByMe });
});

// Cập nhật trạng thái công việc
const updateTaskStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const currentUserId = req.userId;

  if (!status) {
    return res.status(400).json({ error: 'Thiếu trạng thái cập nhật' });
  }

  const validStatuses = ['pending', 'in_progress', 'done', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Trạng thái công việc không hợp lệ' });
  }

  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      conversation: {
        include: { members: true }
      }
    }
  });

  if (!task) {
    return res.status(404).json({ error: 'Không tìm thấy công việc' });
  }

  // Xác minh người dùng có thuộc cuộc hội thoại chứa công việc này không
  const isMember = task.conversation.members.some(m => m.userId === currentUserId);
  if (!isMember) {
    return res.status(403).json({ error: 'Bạn không có quyền thay đổi trạng thái công việc này' });
  }

  // Logic tự nhận việc (Self-assigning) khi đơn hàng giao chung cho Kho Đông Lạnh
  const isSelfAssigning = task.assigneeId === '00000000-0000-0000-0000-000000000001' && currentUserId !== '00000000-0000-0000-0000-000000000001';
  const updateData = { status };
  if (isSelfAssigning) {
    updateData.assigneeId = currentUserId;
  }

  // Tiến hành cập nhật trạng thái và người được giao nếu tự nhận việc
  const updatedTask = await prisma.task.update({
    where: { id },
    data: updateData,
    include: {
      assignee: { select: { id: true, displayName: true, avatarUrl: true } },
      assigner: { select: { id: true, displayName: true, avatarUrl: true } }
    }
  });

  // Cập nhật cả metadata của tin nhắn chứa thẻ công việc để hiển thị đúng khi reload
  if (task.messageId) {
    const message = await prisma.message.findUnique({ where: { id: task.messageId } });
    if (message && message.metadata) {
      try {
        const meta = JSON.parse(message.metadata);
        meta.status = status;
        if (isSelfAssigning) {
          meta.assigneeId = currentUserId;
          meta.assigneeName = updatedTask.assignee.displayName;
        }
        await prisma.message.update({
          where: { id: task.messageId },
          data: { metadata: JSON.stringify(meta) }
        });
      } catch (e) {
        logger.error('Lỗi cập nhật metadata tin nhắn cho task:', e);
      }
    }
  }

  // Phát thông báo real-time tới tất cả thành viên trong nhóm để cập nhật UI lập tức
  const io = req.app.get('io');
  if (io) {
    task.conversation.members.forEach(member => {
      io.to(`user-${member.userId}`).emit('task-status-updated', {
        taskId: task.id,
        status,
        conversationId: task.conversationId,
        updatedBy: currentUserId,
        assigneeId: isSelfAssigning ? currentUserId : undefined,
        assigneeName: isSelfAssigning ? updatedTask.assignee.displayName : undefined
      });
    });
  }

  res.status(200).json(updatedTask);
});

// Lấy danh sách công việc của cuộc hội thoại cụ thể
const getConversationTasks = asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  const currentUserId = req.userId;

  // Xác minh người dùng có thuộc cuộc hội thoại chứa công việc này không
  const isMember = await prisma.conversationMember.findUnique({
    where: {
      conversationId_userId: {
        conversationId,
        userId: currentUserId
      }
    }
  });

  if (!isMember) {
    return res.status(403).json({ error: 'Bạn không có quyền xem danh sách công việc của cuộc trò chuyện này' });
  }

  const tasks = await prisma.task.findMany({
    where: { conversationId },
    include: {
      assignee: { select: { id: true, displayName: true, avatarUrl: true } },
      assigner: { select: { id: true, displayName: true, avatarUrl: true } }
    },
    orderBy: { createdAt: 'desc' }
  });

  res.status(200).json(tasks);
});

module.exports = {
  createTask,
  getTasks,
  updateTaskStatus,
  getConversationTasks
};
