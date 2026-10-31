const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const prisma = require('../db');
const logger = require('../utils/logger');
const { sendNotificationHelper } = require('../controllers/pushController');

const SYSTEM_BOT_ID = '00000000-0000-0000-0000-000000000000';
const SYSTEM_WAREHOUSE_ID = '00000000-0000-0000-0000-000000000001';

// Middleware xác thực API Key hệ thống bằng thuật toán so sánh hằng số thời gian (Timing-safe)
const verifySystemKey = (req, res, next) => {
  const systemKey = String(req.headers['x-system-key'] || '');
  const expectedKey = process.env.SYSTEM_API_KEY || 'chattikovia_secret_api_key_for_kiotviet';

  if (!systemKey) {
    return res.status(401).json({ error: 'Xác thực hệ thống thất bại. Thiếu API Key.' });
  }

  const keyBuf = Buffer.from(systemKey, 'utf8');
  const expectedBuf = Buffer.from(expectedKey, 'utf8');

  if (keyBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(keyBuf, expectedBuf)) {
    return res.status(401).json({ error: 'Xác thực hệ thống thất bại. API Key không hợp lệ.' });
  }
  next();
};

router.post('/tasks/system-create', verifySystemKey, async (req, res) => {
  const { code, customerName, note, total, items } = req.body;

  if (!code || !items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Thiếu thông tin đơn hàng bắt buộc' });
  }

  try {
    // 1. Tìm hoặc tự động tạo group chat "Kho Đông Lạnh"
    let group = await prisma.conversation.findFirst({
      where: {
        isGroup: true,
        name: {
          contains: 'Kho đông lạnh',
          mode: 'insensitive'
        }
      }
    });

    const systemIds = [SYSTEM_BOT_ID, SYSTEM_WAREHOUSE_ID];

    if (group) {
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
      const existingUsers = await prisma.user.findMany({ take: 20 });

      group = await prisma.conversation.create({
        data: {
          name: 'Kho Đông Lạnh',
          isGroup: true,
          avatarUrl: 'https://api.dicebear.com/7.x/initials/svg?seed=KhoDongLanh'
        }
      });

      const memberData = existingUsers.map((u) => ({
        conversationId: group.id,
        userId: u.id,
        role: u.id === SYSTEM_BOT_ID ? 'creator' : 'member'
      }));

      for (const sysId of systemIds) {
        if (!memberData.some((m) => m.userId === sysId)) {
          memberData.push({
            conversationId: group.id,
            userId: sysId,
            role: 'member'
          });
        }
      }

      await prisma.conversationMember.createMany({
        data: memberData,
        skipDuplicates: true
      });
      logger.info(`Đã tạo thành công group Kho Đông Lạnh với ID: ${group.id}`);
    }

    // 2. Chuẩn bị thông tin Task
    const title = `Đơn hàng mới ${code}`;
    const productLines = items
      .map((it) => `- ${it.productName} (SL: ${it.quantity} ${it.unit || 'cái'})`)
      .join('\n');
    const numericTotal = Number(total) || 0;
    const description = `Khách hàng: ${customerName || 'Khách lẻ'}\nTổng tiền: ${numericTotal.toLocaleString('vi-VN')} đ\n${note ? `Ghi chú: ${note}\n` : ''}\nSản phẩm soạn kho:\n${productLines}`;

    const dueDate = new Date(Date.now() + 60 * 60 * 1000);

    // 3. Tạo Task, Message và cập nhật Conversation trong một transaction
    const result = await prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          title,
          description,
          dueDate,
          status: 'pending',
          assignerId: SYSTEM_BOT_ID,
          assigneeId: SYSTEM_WAREHOUSE_ID,
          conversationId: group.id
        },
        include: {
          assignee: { select: { id: true, displayName: true, avatarUrl: true } },
          assigner: { select: { id: true, displayName: true, avatarUrl: true } }
        }
      });

      const message = await tx.message.create({
        data: {
          conversationId: group.id,
          senderId: SYSTEM_BOT_ID,
          type: 'task',
          content: title,
          metadata: JSON.stringify({
            taskId: task.id,
            title,
            description,
            assigneeId: SYSTEM_WAREHOUSE_ID,
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

      const updatedTask = await tx.task.update({
        where: { id: task.id },
        data: { messageId: message.id },
        include: {
          assignee: { select: { id: true, displayName: true, avatarUrl: true } },
          assigner: { select: { id: true, displayName: true, avatarUrl: true } }
        }
      });

      await tx.conversation.update({
        where: { id: group.id },
        data: { updatedAt: new Date() }
      });

      return { task: updatedTask, message };
    });

    // 4. Phát tin nhắn qua socket thời gian thực & gửi Web Push tới điện thoại nhân viên kho
    const convWithMembers = await prisma.conversation.findUnique({
      where: { id: group.id },
      include: { members: true }
    });

    if (convWithMembers) {
      const io = req.app.get('io');
      if (io) {
        convWithMembers.members.forEach((member) => {
          io.to(`user-${member.userId}`).emit('receive-message', result.message);
          io.to(`user-${member.userId}`).emit('conversation-updated', { conversationId: group.id });
        });
      }

      // Gửi Web Push khẩn cấp cho tất cả nhân viên trong nhóm Kho Đông Lạnh
      const humanMembers = convWithMembers.members.filter(
        (m) => !systemIds.includes(m.userId) && !m.isMuted
      );

      await Promise.all(
        humanMembers.map((member) =>
          sendNotificationHelper(member.userId, {
            title: `📦 Đơn hàng KiotViet mới: ${code}`,
            body: `Khách: ${customerName || 'Khách lẻ'} (${items.length} mặt hàng) - Chạm để nhận đơn!`,
            icon: '/pwa-192x192.png',
            tag: `kiotviet-order-${code}`,
            conversationId: group.id,
            data: {
              url: '/',
              conversationId: group.id,
              taskId: result.task.id,
              type: 'task'
            }
          })
        )
      );
    }

    res.status(201).json(result.task);
  } catch (error) {
    logger.error('Lỗi khi tự động tạo công việc từ KiotViet:', error);
    res.status(500).json({ error: 'Lỗi máy chủ khi tạo công việc từ KiotViet' });
  }
});

module.exports = router;
