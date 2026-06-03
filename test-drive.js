require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, './google-credentials.json');

console.log('=== CHƯƠNG TRÌNH KIỂM TRA CHẨN ĐOÁN GOOGLE DRIVE ===');
console.log('Đường dẫn tệp khóa JSON:', credentialsPath);
console.log('Đã tồn tại file khóa chưa:', fs.existsSync(credentialsPath) ? 'RỒI' : 'CHƯA');

if (fs.existsSync(credentialsPath)) {
  try {
    const creds = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    console.log('Project ID:', creds.project_id);
    console.log('Email Service Account:', creds.client_email);
  } catch (e) {
    console.error('Lỗi đọc/parse file JSON khóa:', e.message);
  }
}

console.log('Google Drive Folder ID cấu hình:', process.env.GOOGLE_DRIVE_FOLDER_ID || 'CHƯA CÓ TRONG ENV');

async function testUpload() {
  if (!fs.existsSync(credentialsPath)) {
    console.error('LỖI: Không tìm thấy file google-credentials.json!');
    return;
  }
  if (!process.env.GOOGLE_DRIVE_FOLDER_ID) {
    console.error('LỖI: Chưa cấu hình GOOGLE_DRIVE_FOLDER_ID trong env!');
    return;
  }

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: credentialsPath,
      scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.file'],
    });

    const drive = google.drive({ version: 'v3', auth });

    // Tạo file test tạm thời
    const testFilePath = path.join(__dirname, './test_file_tmp.txt');
    fs.writeFileSync(testFilePath, 'Nội dung kiểm tra liên kết Google Drive ' + new Date().toISOString(), 'utf8');

    console.log('\nĐang thử tải file test lên Google Drive...');
    
    const fileMetadata = {
      name: 'Test_Connection_' + Date.now() + '.txt',
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID]
    };

    const media = {
      mimeType: 'text/plain',
      body: fs.createReadStream(testFilePath)
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink',
      supportsAllDrives: true
    });

    console.log('✅ KẾT QUẢ: TẢI LÊN THÀNH CÔNG!');
    console.log('File ID:', response.data.id);
    console.log('Link xem file:', response.data.webViewLink);

    // Thử cấp quyền công khai
    console.log('Đang thử thiết lập quyền chia sẻ công khai...');
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      },
      supportsAllDrives: true
    });
    console.log('✅ KẾT QUẢ: CẤP QUYỀN ĐỌC CÔNG KHAI THÀNH CÔNG!');

    // Xóa file test tạm
    fs.unlinkSync(testFilePath);
  } catch (error) {
    console.error('\n❌ KẾT QUẢ: THẤT BẠI!');
    console.error('CHI TIẾT LỖI HỆ THỐNG:');
    if (error.response) {
      console.error('Mã lỗi HTTP:', error.response.status);
      console.error('Nội dung lỗi API:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message || error);
    }
    console.error('\nHƯỚNG DẪN XỬ LÝ LỖI:');
    console.error('1. Nếu lỗi 403/Forbidden: Hãy đảm bảo bạn đã cấp quyền "Editor" (Người chỉnh sửa) cho email Service Account trong thư mục Google Drive.');
    console.error('2. Nếu lỗi 404/Not Found: Thư mục Folder ID không tồn tại hoặc Service Account không được chia sẻ quyền truy cập.');
    console.error('3. Nếu lỗi Google Drive API has not been used: Hãy nhấp vào liên kết hiện trong lỗi để kích hoạt API Google Drive trên Google Cloud Console.');
  }
}

testUpload();
