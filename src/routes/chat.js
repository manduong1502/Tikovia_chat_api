const express = require('express');
const router = express.Router();
const fs = require('fs');
const chatController = require('../controllers/chatController');
const pushController = require('../controllers/pushController');
const verifyToken = require('../middlewares/authMiddleware');
const { uploadMiddleware } = require('../utils/storage');
const logger = require('../utils/logger');

// Tất cả API chat yêu cầu xác thực JWT
router.use(verifyToken);

// API Quản lý Hội thoại & Tin nhắn
router.post('/conversations', chatController.createConversation);
router.get('/conversations', chatController.getConversations);
router.get('/conversations/:conversationId/messages', chatController.getMessages);
router.post('/conversations/:conversationId/read', chatController.markConversationRead);
router.put('/conversations/:conversationId/mute', chatController.toggleMuteConversation);
router.post('/conversations/:conversationId/nickname', chatController.setNickname);
router.put('/messages/:messageId/pin', chatController.togglePinMessage);
router.post('/messages/:messageId/delete-for-me', chatController.deleteMessageForMe);
router.post('/reminders', chatController.createReminder);
router.get('/conversations/:conversationId/media', chatController.getMediaGallery);

// API Quản lý Nhóm
router.post('/conversations/:conversationId/members', chatController.addGroupMembers);
router.delete('/conversations/:conversationId/members/:userId', chatController.removeGroupMember);
router.put('/conversations/:conversationId', chatController.updateGroupDetails);

// API Thông báo đẩy trên thiết bị di động (Đặt tên tránh bị các bộ lọc AdBlock chặn)
router.get('/device-key', pushController.getPublicKey);
router.post('/device-token', pushController.subscribe);
router.post('/device-unsubscribe', pushController.unsubscribe);
router.post('/device-test', pushController.testPushNotification);

// API Upload tệp, ảnh, ghi âm trực tiếp vào ổ cứng SSD của Ubuntu Mini Server
router.post('/upload', (req, res, next) => {
  uploadMiddleware.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Dung lượng tệp vượt quá giới hạn cho phép của máy chủ.' });
      }
      return res.status(400).json({ error: err.message || 'Lỗi kiểm tra tệp tải lên.' });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Không tìm thấy tệp để tải lên.' });
    }

    const fileName = req.file.decodedOriginalName || req.file.originalname;
    const mimeType = req.file.mimetype;
    const fileSize = req.file.size;
    const subDir = req._uploadSubDir ? `${req._uploadSubDir}/` : '';
    const fileUrl = `/api/uploads/${subDir}${req.file.filename}`;

    return res.json({
      message: 'Lưu tệp lên ổ cứng máy chủ thành công',
      url: fileUrl,
      fileName,
      fileSize,
      mimeType,
      storageType: 'local'
    });
  } catch (error) {
    logger.error('Lỗi upload tệp lên SSD:', error);
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
    }
    return res.status(500).json({ error: 'Lỗi máy chủ khi lưu tệp lên ổ cứng.' });
  }
});

module.exports = router;
