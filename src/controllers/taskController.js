const prisma = require('../db');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const { sendNotificationHelper } = require('./pushController');

const SYSTEM_WAREHOUSE_ID = '00000000-0000-0000-0000-000000000001';
const SYSTEM_BOT_ID = '00000000-0000-0000-0000-000000000000';

// Tạo công việc mới
const createTask = asyncHandler(async (req, res) => {
  const { title, description, assigneeId, dueDate, conversationId } = req.body;
  const assignerId = req.userId;

  if (!title || !String(title).trim() || !assigneeId || !conversationId) {
    return res.status(400).json({ error: 'Thiếu thông tin công việc bắt buộc' });
  }

  const cleanTitle = String(title).trim();

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

  // 3. Sử dụng transaction để tạo Task, Message và cập nhật Conversation đồng bộ
  const result = await prisma.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        title: cleanTitle,
        description: description ? String(description).trim() : null,
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

    const message = await tx.message.create({
      data: {
        conversationId,
        senderId: assignerId,
        type: 'task',
        content: cleanTitle,
        metadata: JSON.stringify({
          taskId: task.id,
          title: cleanTitle,
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

    await tx.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() }
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
      conv.members.forEach((member) => {
        io.to(`user-${member.userId}`).emit('receive-message', result.message);
        io.to(`user-${member.userId}`).emit('conversation-updated', { conversationId });
      });
    }
  }

  // 5. Gửi Web Push Notification khẩn cấp tới điện thoại người được giao việc
  if (assigneeId !== assignerId && assigneeId !== SYSTEM_WAREHOUSE_ID) {
    sendNotificationHelper(assigneeId, {
      title: `📋 Công việc mới từ ${result.task.assigner.displayName}`,
      body: cleanTitle,
      icon: result.task.assigner.avatarUrl || '/pwa-192x192.png',
      tag: `task-${result.task.id}`,
      conversationId,
      data: {
        url: '/',
        conversationId,
        taskId: result.task.id,
        type: 'task'
      }
    }).catch((err) => logger.error('Lỗi gửi push khi giao việc:', err));
  }

  res.status(201).json(result.task);
});

// Lấy danh sách công việc của bản thân (Bao gồm cả đơn hàng Kho Đông Lạnh chưa có người nhận trong các nhóm mình tham gia)
const getTasks = asyncHandler(async (req, res) => {
  const currentUserId = req.userId;

  const assignedToMe = await prisma.task.findMany({
    where: {
      OR: [
        { assigneeId: currentUserId },
        {
          assigneeId: SYSTEM_WAREHOUSE_ID,
          conversation: {
            members: {
              some: { userId: currentUserId }
            }
          }
        }
      ]
    },
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

// Cập nhật trạng thái công việc (Có kiểm tra chặt chẽ quyền Người giao / Người nhận)
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

  const isMember = task.conversation.members.some((m) => m.userId === currentUserId);
  if (!isMember) {
    return res.status(403).json({ error: 'Bạn không thuộc phòng chat chứa công việc này' });
  }

  // Logic tự nhận việc (Self-assigning) khi đơn hàng giao chung cho Kho Đông Lạnh
  const isSelfAssigning =
    task.assigneeId === SYSTEM_WAREHOUSE_ID && currentUserId !== SYSTEM_WAREHOUSE_ID;
  const isAssigner = task.assignerId === currentUserId;
  const isAssignee = task.assigneeId === currentUserId;

  if (!isAssigner && !isAssignee && !isSelfAssigning) {
    return res.status(403).json({
      error: 'Chỉ người giao việc hoặc người được giao việc mới có quyền cập nhật trạng thái'
    });
  }

  if (status === 'cancelled' && !isAssigner) {
    return res.status(403).json({
      error: 'Chỉ người giao việc mới có quyền hủy công việc này'
    });
  }

  const updateData = { status };
  if (isSelfAssigning) {
    updateData.assigneeId = currentUserId;
  }

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

  // Phát thông báo real-time tới tất cả thành viên trong nhóm
  const io = req.app.get('io');
  if (io) {
    task.conversation.members.forEach((member) => {
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

  // Gửi Web Push thông báo cho người giao việc khi công việc được hoàn thành
  if (
    status === 'done' &&
    task.assignerId &&
    task.assignerId !== currentUserId &&
    task.assignerId !== SYSTEM_BOT_ID
  ) {
    sendNotificationHelper(task.assignerId, {
      title: `✅ Hoàn thành: ${updatedTask.title}`,
      body: `${updatedTask.assignee.displayName} đã đánh dấu hoàn thành công việc.`,
      icon: updatedTask.assignee.avatarUrl || '/pwa-192x192.png',
      tag: `task-${updatedTask.id}`,
      conversationId: task.conversationId,
      data: {
        url: '/',
        conversationId: task.conversationId,
        taskId: updatedTask.id,
        type: 'task'
      }
    }).catch((err) => logger.error('Lỗi gửi push hoàn thành công việc:', err));
  }

  res.status(200).json(updatedTask);
});

// Lấy danh sách công việc của cuộc hội thoại cụ thể
const getConversationTasks = asyncHandler(async (req, res) => {
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
