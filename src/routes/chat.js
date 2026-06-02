const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const chatController = require('../controllers/chatController');
const verifyToken = require('../middlewares/authMiddleware');

// Cấu hình lưu trữ tệp tin upload
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // Giới hạn 50MB
});

// Các API chat
router.use(verifyToken); // Tất cả API chat yêu cầu đăng nhập

router.post('/conversations', chatController.createConversation);
router.get('/conversations', chatController.getConversations);
router.get('/conversations/:conversationId/messages', chatController.getMessages);
router.post('/conversations/:conversationId/nickname', chatController.setNickname);
router.put('/messages/:messageId/pin', chatController.togglePinMessage);
router.post('/reminders', chatController.createReminder);
router.get('/conversations/:conversationId/media', chatController.getMediaGallery);

// API upload tệp và ảnh
router.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Không tìm thấy tệp để upload' });
    }
    
    // Tạo đường dẫn URL để client truy cập
    const fileUrl = `/uploads/${req.file.filename}`;
    
    res.json({
      message: 'Tải lên thành công',
      url: fileUrl,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype
    });
  } catch (error) {
    console.error('Lỗi upload tệp:', error);
    res.status(500).json({ error: 'Lỗi máy chủ khi tải lên tệp' });
  }
});

module.exports = router;
