const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// Đường dẫn mặc định đến file khóa JSON của Service Account
const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, '../../google-credentials.json');

// Biến lưu trữ đối tượng drive
let driveClient = null;

// Hàm kiểm tra xem cấu hình Google Drive có sẵn sàng không
function isDriveConfigured() {
  // Kiểm tra file JSON credential
  if (!fs.existsSync(credentialsPath)) {
    return false;
  }
  // Kiểm tra Folder ID cấu hình trong env
  if (!process.env.GOOGLE_DRIVE_FOLDER_ID) {
    return false;
  }
  return true;
}

// Khởi tạo Google Drive Client
function getDriveClient() {
  if (driveClient) return driveClient;

  if (!isDriveConfigured()) {
    throw new Error('Google Drive chưa được cấu hình. Thiếu file google-credentials.json hoặc GOOGLE_DRIVE_FOLDER_ID trong file .env');
  }

  try {
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
    console.error('[Google Drive] Khởi tạo Drive client thất bại:', error);
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
    
    // 1. Thực hiện tải file lên
    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink, webContentLink'
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
        }
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
