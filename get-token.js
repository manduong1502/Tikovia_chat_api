const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

console.log('=== TIỆN ÍCH LẤY REFRESH TOKEN GOOGLE DRIVE (CHO GMAIL CÁ NHÂN) ===');
console.log('Để chạy tiện ích này, bạn cần tạo thông tin xác thực OAuth Client ID trên Google Cloud Console.');
console.log('Hướng dẫn tạo OAuth Client ID:');
console.log('1. Vào https://console.cloud.google.com/apis/credentials');
console.log('2. Nhấp "Tạo thông tin xác thực" (Create Credentials) > "Mã khách hàng OAuth" (OAuth client ID)');
console.log('3. Chọn loại ứng dụng: "Ứng dụng Web" (Web application)');
console.log('4. Ở phần "Nguồn gốc JavaScript được ủy quyền", thêm: http://localhost:3000');
console.log('5. Ở phần "URI chuyển hướng được ủy quyền", thêm: ' + REDIRECT_URI);
console.log('6. Nhấn Tạo và copy Client ID cùng Client Secret dán vào dưới đây:\n');

const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout
});

readline.question('Nhập Client ID của bạn: ', (clientId) => {
  if (!clientId.trim()) {
    console.error('Lỗi: Client ID không được để trống.');
    process.exit(1);
  }
  
  readline.question('Nhập Client Secret của bạn: ', (clientSecret) => {
    if (!clientSecret.trim()) {
      console.error('Lỗi: Client Secret không được để trống.');
      process.exit(1);
    }
    
    readline.close();
    startAuthFlow(clientId.trim(), clientSecret.trim());
  });
});

function startAuthFlow(clientId, clientSecret) {
  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    REDIRECT_URI
  );

  // Tạo URL xác thực để người dùng click
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Bắt buộc để lấy Refresh Token dài hạn
    prompt: 'consent',      // Bắt buộc hiển thị lại bảng hỏi để sinh refresh token mỗi lần test
    scope: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.file'
    ]
  });

  // Tạo server local lắng nghe mã ủy quyền từ Google gửi về
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/oauth2callback')) {
        const query = url.parse(req.url, true).query;
        const code = query.code;

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h3>Xác thực thành công! Bạn có thể quay lại terminal để lấy thông tin cấu hình.</h3>');
          
          // Đổi mã lấy token
          console.log('\nĐang trao đổi mã ủy quyền lấy token...');
          const { tokens } = await oauth2Client.getToken(code);
          
          console.log('\n======================================================');
          console.log('🎉 XÁC THỰC THÀNH CÔNG! HÃY SAO CHÉP CÁC DÒNG DƯỚI ĐÂY VÀO TỆP .env:');
          console.log('======================================================\n');
          console.log(`GOOGLE_CLIENT_ID=${clientId}`);
          console.log(`GOOGLE_CLIENT_SECRET=${clientSecret}`);
          console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
          console.log('\n======================================================');
          
          server.close();
          process.exit(0);
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Thiếu mã authorization code.');
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    } catch (err) {
      console.error('Lỗi xử lý xác thực:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Lỗi máy chủ: ' + err.message);
    }
  });

  server.listen(PORT, () => {
    console.log(`\n1. Hãy mở trình duyệt và truy cập liên kết dưới đây để cấp quyền truy cập Drive:`);
    console.log(`\n👉 \x1b[36m${authUrl}\x1b[0m\n`);
    console.log(`2. Đang chờ bạn thực hiện xác thực trên trình duyệt...`);
  });
}
