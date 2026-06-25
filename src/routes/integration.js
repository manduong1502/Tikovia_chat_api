const express = require('express');
const router = express.Router();
const prisma = require('../db');
const logger = require('../utils/logger');

// Middleware xác thực API Key hệ thống
const verifySystemKey = (req, res, next) => {
  const systemKey = req.headers['x-system-key'];
  const expectedKey = process.env.SYSTEM_API_KEY || 'chattikovia_secret_api_key_for_kiotviet';
  if (!systemKey || systemKey !== expectedKey) {
    return res.status(401).json({ error: 'Xác thực hệ thống thất bại. API Key không hợp lệ.' });
  }
  next();
};

router.post('/tasks/system-create', verifySystemKey, async (req, res) => {
  const { code, customerName, note, subtotal, total, items } = req.body;

  if (!code || !items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Thiếu thông tin đơn hàng bắt buộc' });
  }

  try {
    // 1. Tìm hoặc tự động tạo group chat "Kho đông lạnh"
    let group = await prisma.conversation.findFirst({
      where: {
        isGroup: true,
        name: {
          contains: 'Kho đông lạnh',
          mode: 'insensitive'
        }
      }
    });

    if (group) {
      // Đảm bảo các tài khoản hệ thống ảo là thành viên của nhóm để giữ toàn vẹn dữ liệu
      const systemIds = [
        '00000000-0000-0000-0000-000000000000', // system_bot
        '00000000-0000-0000-0000-000000000001'  // khodonglanh
      ];
      for (const sysId of systemIds) {
        await prisma.conversationMember.upsert({
          where: {
            conversationId_userId: {
              conversationId: group.id,
              userId: sysId
            }
          },
          update: {},
          create: {
            conversationId: group.id,
            userId: sysId,
            role: 'member'
          }
        });
      }
    } else {
      logger.info('Không tìm thấy group Kho Đông Lạnh. Đang tự động tạo mới...');
      // Lấy tất cả user hiện có trong DB (lên tới 10 user) để làm thành viên
      const existingUsers = await prisma.user.findMany({ take: 10 });
      
      // Tạo group mới
      group = await prisma.conversation.create({
        data: {
          name: 'Kho Đông Lạnh',
          isGroup: true,
          avatarUrl: '/avatars/group-warehouse.png'
        }
      });

      // Thêm các thành viên vào group
      const memberData = existingUsers.map(u => ({
        conversationId: group.id,
        userId: u.id,
        role: u.id === '00000000-0000-0000-0000-000000000000' ? 'creator' : 'member'
      }));

      // Đảm bảo có tài khoản ảo Kho Đông Lạnh và Bot trong nhóm
      const systemIds = [
        '00000000-0000-0000-0000-000000000000', // system_bot
        '00000000-0000-0000-0000-000000000001'  // khodonglanh
      ];
      for (const sysId of systemIds) {
        if (!memberData.some(m => m.userId === sysId)) {
          memberData.push({
            conversationId: group.id,
            userId: sysId,
            role: 'member'
          });
        }
      }

      await prisma.conversationMember.createMany({
        data: memberData
      });
      logger.info(`Đã tạo thành công group Kho Đông Lạnh với ID: ${group.id}`);
    }

    // 2. Chuẩn bị thông tin Task
    const title = `Đơn hàng mới ${code}`;
    const productLines = items.map(it => `- ${it.productName} (SL: ${it.quantity} ${it.unit || 'cái'})`).join('\n');
    const description = `Khách hàng: ${customerName || 'Khách lẻ'}\nTổng tiền: ${total.toLocaleString('vi-VN')} đ\n${note ? `Ghi chú: ${note}\n` : ''}\nSản phẩm soạn kho:\n${productLines}`;
    
    // Hạn chót mặc định: 1 tiếng sau
    const dueDate = new Date(Date.now() + 60 * 60 * 1000);

    const assignerId = '00000000-0000-0000-0000-000000000000'; // system_bot
    const assigneeId = '00000000-0000-0000-0000-000000000001'; // khodonglanh (Tài khoản ảo Kho)

    // 3. Tạo Task và Message trong một transaction
    const result = await prisma.$transaction(async (tx) => {
      // Tạo Task trước
      const task = await tx.task.create({
        data: {
          title,
          description,
          dueDate,
          status: 'pending',
          assignerId,
          assigneeId,
          conversationId: group.id
        },
        include: {
          assignee: { select: { id: true, displayName: true, avatarUrl: true } },
          assigner: { select: { id: true, displayName: true, avatarUrl: true } }
        }
      });

      // Tạo tin nhắn thông báo dạng 'task'
      const message = await tx.message.create({
        data: {
          conversationId: group.id,
          senderId: assignerId,
          type: 'task',
          content: title,
          metadata: JSON.stringify({
            taskId: task.id,
            title,
            description,
            assigneeId,
            assigneeName: task.assignee.displayName,
            dueDate: dueDate.toISOString(),
            status: 'pending'
          })
        },
        include: {
          sender: {
            select: { id: true, displayName: true, avatarUrl: true, username: true }
          }
        }
      });

      // Cập nhật lại Task để lưu liên kết messageId
      const updatedTask = await tx.task.update({
        where: { id: task.id },
        data: { messageId: message.id },
        include: {
          assignee: { select: { id: true, displayName: true, avatarUrl: true } },
          assigner: { select: { id: true, displayName: true, avatarUrl: true } }
        }
      });

      return { task: updatedTask, message };
    });

    // 4. Phát tin nhắn qua socket thời gian thực
    const io = req.app.get('io');
    if (io) {
      const convWithMembers = await prisma.conversation.findUnique({
        where: { id: group.id },
        include: { members: true }
      });
      if (convWithMembers) {
        convWithMembers.members.forEach(member => {
          io.to(`user-${member.userId}`).emit('receive-message', result.message);
        });
        io.emit('conversation-updated', { conversationId: group.id });
      }
    }

    res.status(201).json(result.task);
  } catch (error) {
    logger.error('Lỗi khi tự động tạo công việc từ KiotViet:', error);
    res.status(500).json({ error: 'Lỗi máy chủ khi tạo công việc từ KiotViet' });
  }
});

module.exports = router;
