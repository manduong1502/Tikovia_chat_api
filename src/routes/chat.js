const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const chatController = require('../controllers/chatController');
const pushController = require('../controllers/pushController');
const verifyToken = require('../middlewares/authMiddleware');

// Nhập tiện ích Google Drive
const { isDriveConfigured, uploadFileToDrive } = require('../utils/googleDrive');

// Cấu hình thư mục lưu trữ
const tempUploadDir = './temp_uploads';
const localUploadDir = './uploads';

if (!fs.existsSync(tempUploadDir)) {
  fs.mkdirSync(tempUploadDir, { recursive: true });
}
if (!fs.existsSync(localUploadDir)) {
  fs.mkdirSync(localUploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, tempUploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5000 * 1024 * 1024 } // Hỗ trợ tệp lớn tối đa 5GB (không giới hạn thực tế cho chat)
});

// Các API chat
router.use(verifyToken); // Tất cả API chat yêu cầu đăng nhập

router.post('/conversations', chatController.createConversation);
router.get('/conversations', chatController.getConversations);
router.get('/conversations/:conversationId/messages', chatController.getMessages);
router.post('/conversations/:conversationId/nickname', chatController.setNickname);
router.put('/messages/:messageId/pin', chatController.togglePinMessage);
router.post('/messages/:messageId/delete-for-me', chatController.deleteMessageForMe);
router.post('/reminders', chatController.createReminder);
router.get('/conversations/:conversationId/media', chatController.getMediaGallery);

// API thông báo đẩy (Đổi tên để tránh bị các bộ lọc quảng cáo/AdBlock chặn)
router.get('/device-key', pushController.getPublicKey);
router.post('/device-token', pushController.subscribe);

// API upload tệp và ảnh lên Google Drive (có fallback lưu cục bộ)
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Không tìm thấy tệp để upload' });
    }

    const tempFilePath = req.file.path;
    const fileName = req.file.originalname;
    const mimeType = req.file.mimetype;
    const fileSize = req.file.size;

    // Kiểm tra xem Google Drive đã cấu hình chưa
    if (isDriveConfigured()) {
      try {
        const driveResult = await uploadFileToDrive(tempFilePath, fileName, mimeType);

        // Xoá file đệm tạm thời trên đĩa cứng server
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }

        return res.json({
          message: 'Tải lên Google Drive thành công',
          url: driveResult.webContentLink,
          webViewLink: driveResult.webViewLink,
          fileName: fileName,
          fileSize: fileSize,
          mimeType: mimeType,
          storageType: 'google_drive',
          driveId: driveResult.id
        });
      } catch (driveError) {
        console.error('[Upload API] Lỗi tải lên Google Drive, chuyển sang lưu trữ cục bộ:', driveError);
        
        // Cú pháp Fallback: Di chuyển file từ đệm tạm thời sang thư mục lưu cục bộ (dùng copy + unlink tránh lỗi cross-device EXDEV trong Docker)
        const localFileName = req.file.filename;
        const localFilePath = path.join(localUploadDir, localFileName);
        
        try {
          fs.copyFileSync(tempFilePath, localFilePath);
          if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
          }
        } catch (copyErr) {
          console.error('[Upload API] Lỗi sao chép tệp cục bộ fallback:', copyErr);
          throw copyErr;
        }

        return res.json({
          message: 'Tải lên cục bộ thành công (Lỗi kết nối Google Drive)',
          url: `/uploads/${localFileName}`,
          fileName: fileName,
          fileSize: fileSize,
          mimeType: mimeType,
          storageType: 'local'
        });
      }
    } else {
      // Google Drive chưa được cấu hình, lưu cục bộ
      console.warn('[Upload API] Google Drive chưa được cấu hình, chuyển sang lưu tệp cục bộ.');
      const localFileName = req.file.filename;
      const localFilePath = path.join(localUploadDir, localFileName);

      try {
        fs.copyFileSync(tempFilePath, localFilePath);
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      } catch (copyErr) {
        console.error('[Upload API] Lỗi sao chép tệp cục bộ khi chưa cấu hình:', copyErr);
        throw copyErr;
      }

      return res.json({
        message: 'Tải lên cục bộ thành công (Chưa cấu hình Google Drive)',
        url: `/uploads/${localFileName}`,
        fileName: fileName,
        fileSize: fileSize,
        mimeType: mimeType,
        storageType: 'local'
      });
    }
  } catch (error) {
    console.error('Lỗi upload tệp:', error);
    // Dọn dẹp tệp tạm nếu có lỗi đột xuất
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
    }
    res.status(500).json({ error: 'Lỗi máy chủ khi tải lên tệp' });
  }
});

module.exports = router;
