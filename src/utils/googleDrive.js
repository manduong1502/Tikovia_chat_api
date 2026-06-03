const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// Đường dẫn mặc định đến file khóa JSON của Service Account
const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, '../../google-credentials.json');

// Biến lưu trữ đối tượng drive
let driveClient = null;

// Hàm kiểm tra xem cấu hình Google Drive có sẵn sàng không
// Hàm kiểm tra xem cấu hình Google Drive có sẵn sàng không (hỗ trợ cả OAuth2 và Service Account)
function isDriveConfigured() {
  // 1. Kiểm tra cấu hình OAuth2 cho tài khoản Gmail cá nhân
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
    return true;
  }
  // 2. Kiểm tra cấu hình Service Account cho tài khoản Google Workspace công ty
  if (fs.existsSync(credentialsPath) && process.env.GOOGLE_DRIVE_FOLDER_ID) {
    return true;
  }
  return false;
}

// Khởi tạo Google Drive Client
function getDriveClient() {
  if (driveClient) return driveClient;

  if (!isDriveConfigured()) {
    throw new Error('Google Drive chưa được cấu hình. Cần file google-credentials.json hoặc cấu hình GOOGLE_REFRESH_TOKEN trong file .env');
  }

  // 1. Nếu có cấu hình OAuth2, sử dụng xác thực tài khoản cá nhân (để không bị giới hạn quota 403)
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
    try {
      console.log('[Google Drive] Đang khởi tạo kết nối OAuth2 (Gmail cá nhân)...');
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        'http://localhost:3000/oauth2callback'
      );

      oauth2Client.setCredentials({
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN
      });

      driveClient = google.drive({ version: 'v3', auth: oauth2Client });
      return driveClient;
    } catch (error) {
      console.error('[Google Drive] Khởi tạo OAuth2 client thất bại:', error);
      throw error;
    }
  }

  // 2. Fallback sử dụng Service Account
  try {
    console.log('[Google Drive] Đang khởi tạo kết nối Service Account...');
    const auth = new google.auth.GoogleAuth({
      keyFile: credentialsPath,
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/drive.file'
      ],
    });

    driveClient = google.drive({ version: 'v3', auth });
    return driveClient;
  } catch (error) {
    console.error('[Google Drive] Khởi tạo Service Account client thất bại:', error);
    throw error;
  }
}

/**
 * Tải file từ đĩa cứng server lên Google Drive của công ty
 * @param {string} filePath Đường dẫn tệp tạm trên server
 * @param {string} fileName Tên hiển thị của tệp khi lên Drive
 * @param {string} mimeType Định dạng MIME của tệp
 * @returns {Promise<{id: string, webViewLink: string, webContentLink: string}>}
 */
async function uploadFileToDrive(filePath, fileName, mimeType) {
  const drive = getDriveClient();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Không tìm thấy tệp cục bộ để tải lên: ${filePath}`);
  }

  try {
    const fileMetadata = {
      name: fileName,
      parents: folderId ? [folderId] : []
    };

    const media = {
      mimeType: mimeType,
      body: fs.createReadStream(filePath)
    };

    console.log(`[Google Drive] Đang tải tệp "${fileName}" lên thư mục Drive ID: ${folderId}...`);
    
    // 1. Thực hiện tải file lên (thêm supportsAllDrives: true để hỗ trợ Shared Drive của công ty)
    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink, webContentLink',
      supportsAllDrives: true
    });

    const file = response.data;
    console.log(`[Google Drive] Tải lên hoàn tất. File ID: ${file.id}`);

    // 2. Thiết lập quyền chia sẻ công khai (bất kỳ ai có link đều có thể đọc/tải)
    // Điều này bắt buộc để render được ảnh trực tiếp trên bong bóng chat của các thành viên
    try {
      await drive.permissions.create({
        fileId: file.id,
        requestBody: {
          role: 'reader',
          type: 'anyone'
        },
        supportsAllDrives: true
      });
      console.log(`[Google Drive] Đã cấp quyền xem công khai cho File ID: ${file.id}`);
    } catch (permError) {
      console.warn(`[Google Drive] Không thể thiết lập quyền chia sẻ công khai cho file ${file.id}:`, permError.message);
    }

    // 3. Trả về liên kết webViewLink và link tải trực tiếp (webContentLink / directLink)
    // Direct link dạng: https://drive.google.com/uc?export=download&id=FILE_ID
    const directDownloadLink = `https://drive.google.com/uc?export=download&id=${file.id}`;

    return {
      id: file.id,
      webViewLink: file.webViewLink,
      webContentLink: directDownloadLink
    };
  } catch (error) {
    console.error(`[Google Drive] Lỗi xảy ra khi tải tệp "${fileName}" lên Drive:`, error);
    throw error;
  }
}

module.exports = {
  isDriveConfigured,
  uploadFileToDrive
};
