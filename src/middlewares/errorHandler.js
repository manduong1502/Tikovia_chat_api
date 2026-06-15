const logger = require('../utils/logger');

// Global error handler middleware for Express
function errorHandler(err, req, res, next) {
  const isProduction = process.env.NODE_ENV === 'production';
  
  // Log lỗi chi tiết lên file logger
  logger.error(`[Error Handler] ${req.method} ${req.path}`, err);

  // Phân loại một số lỗi Prisma phổ biến
  let statusCode = err.status || 500;
  let errorMessage = err.message || 'Đã xảy ra lỗi máy chủ nội bộ';

  if (err.code) {
    // Mã lỗi Prisma (https://www.prisma.io/docs/reference/api-reference/error-reference)
    switch (err.code) {
      case 'P2002': // Trùng lặp trường unique (Unique constraint failed)
        statusCode = 400;
        const field = err.meta?.target ? ` (${err.meta.target})` : '';
        errorMessage = `Dữ liệu bị trùng lặp. Trường dữ liệu đã tồn tại${field}.`;
        break;
      case 'P2025': // Không tìm thấy bản ghi cần update/delete (Record not found)
        statusCode = 404;
        errorMessage = 'Không tìm thấy tài nguyên yêu cầu hoặc bạn không có quyền truy cập.';
        break;
      case 'P2003': // Lỗi khóa ngoại (Foreign key constraint failed)
        statusCode = 400;
        errorMessage = 'Dữ liệu liên kết không hợp lệ (lỗi khóa ngoại).';
        break;
      default:
        break;
    }
  }

  // Nếu có lỗi JWT
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    errorMessage = 'Token xác thực không hợp lệ.';
  } else if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    errorMessage = 'Phiên đăng nhập đã hết hạn.';
  }

  res.status(statusCode).json({
    error: errorMessage,
    ...(isProduction ? {} : { stack: err.stack, details: err })
  });
}

module.exports = errorHandler;
