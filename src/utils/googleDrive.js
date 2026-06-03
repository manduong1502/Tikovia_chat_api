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
 * Tìm hoặc tạo thư mục con bên trong thư mục cha trên Google Drive
 * @param {object} drive Đối tượng Google Drive client
 * @param {string} parentId ID của thư mục cha
 * @param {string} folderName Tên thư mục con cần tìm hoặc tạo
 * @returns {Promise<string>} ID của thư mục con
 */
async function getOrCreateSubfolder(drive, parentId, folderName) {
  try {
    // 1. Tìm kiếm thư mục con có tên folderName trong thư mục cha parentId và chưa bị xóa (trashed = false)
    const query = `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`;
    const searchResponse = await drive.files.list({
      q: query,
      spaces: 'drive',
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });

    const files = searchResponse.data.files;
    if (files && files.length > 0) {
      console.log(`[Google Drive] Tìm thấy thư mục con "${folderName}" có sẵn, ID: ${files[0].id}`);
      return files[0].id;
    }

    // 2. Nếu không tìm thấy, tiến hành tạo mới thư mục con
    console.log(`[Google Drive] Chưa có thư mục "${folderName}", đang tạo mới bên trong thư mục cha ID: ${parentId}...`);
    const createResponse = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      },
      fields: 'id',
      supportsAllDrives: true
    });

    const newFolderId = createResponse.data.id;
    console.log(`[Google Drive] Đã tạo thư mục con "${folderName}" thành công, ID: ${newFolderId}`);
    
    // Cấp quyền đọc công khai cho thư mục này để các file bên trong dễ kế thừa quyền
    try {
      await drive.permissions.create({
        fileId: newFolderId,
        requestBody: {
          role: 'reader',
          type: 'anyone'
        },
        supportsAllDrives: true
      });
    } catch (permErr) {
      console.warn(`[Google Drive] Không thể thiết lập quyền chia sẻ công khai cho thư mục ${folderName}:`, permErr.message);
    }

    return newFolderId;
  } catch (error) {
    console.error(`[Google Drive] Lỗi khi tìm/tạo thư mục con "${folderName}":`, error);
    // Nếu có lỗi xảy ra, trả về luôn parentId làm fallback
    return parentId;
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
    // Xác định thư mục con dựa trên loại tệp (ảnh vs các tệp khác)
    let targetFolderId = folderId;
    if (folderId) {
      const subfolderName = mimeType.startsWith('image/') ? 'Ảnh' : 'Tài liệu & Tệp khác';
      targetFolderId = await getOrCreateSubfolder(drive, folderId, subfolderName);
    }

    const fileMetadata = {
      name: fileName,
      parents: targetFolderId ? [targetFolderId] : []
    };

    const media = {
      mimeType: mimeType,
      body: fs.createReadStream(filePath)
    };

    console.log(`[Google Drive] Đang tải tệp "${fileName}" lên thư mục Drive ID: ${targetFolderId}...`);
    
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

/**
 * Lấy luồng dữ liệu (stream) của tệp từ Google Drive
 * @param {string} fileId ID của tệp trên Google Drive
 * @returns {Promise<{stream: NodeJS.ReadableStream, mimeType: string, size: number}>}
 */
async function getFileStreamFromDrive(fileId) {
  const drive = getDriveClient();

  try {
    // 1. Lấy metadata của file để biết Content-Type và kích thước file
    const metaResponse = await drive.files.get({
      fileId: fileId,
      fields: 'mimeType, size, name',
      supportsAllDrives: true
    });

    const { mimeType, size, name } = metaResponse.data;

    // 2. Lấy stream nội dung file
    const response = await drive.files.get({
      fileId: fileId,
      alt: 'media',
      supportsAllDrives: true
    }, {
      responseType: 'stream'
    });

    return {
      stream: response.data,
      mimeType: mimeType,
      size: size ? parseInt(size, 10) : null,
      name: name
    };
  } catch (error) {
    console.error(`[Google Drive] Lỗi khi lấy file stream cho File ID ${fileId}:`, error);
    throw error;
  }
}

module.exports = {
  isDriveConfigured,
  uploadFileToDrive,
  getFileStreamFromDrive
};
