const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../db');
const { JWT_SECRET } = require('../config');
const { deleteLocalFile } = require('../utils/storage');

const SYSTEM_USER_IDS = [
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-000000000001'
];

// Đăng ký người dùng mới
async function register(req, res) {
  try {
    const { username, password, displayName, phone, avatarUrl } = req.body;

    if (!username || !password || !displayName) {
      return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });
    }

    const usernameRegex = /^[a-zA-Z0-9_]{3,30}$/;
    if (!usernameRegex.test(username)) {
      return res.status(400).json({ error: 'Tên đăng nhập phải từ 3-30 ký tự và chỉ chứa chữ cái, số, hoặc dấu gạch dưới' });
    }

    if (displayName.length < 2 || displayName.length > 50) {
      return res.status(400).json({ error: 'Tên hiển thị phải từ 2-50 ký tự' });
    }

    if (password.length < 6 || password.length > 72) {
      return res.status(400).json({ error: 'Mật khẩu phải từ 6-72 ký tự' });
    }

    const existingUser = await prisma.user.findUnique({ where: { username } });
    if (existingUser) {
      return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        displayName: displayName.trim(),
        phone: phone ? String(phone).trim() : null,
        avatarUrl: avatarUrl || null,
        status: 'offline',
      },
    });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      message: 'Đăng ký thành công',
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        phone: user.phone,
        avatarUrl: user.avatarUrl,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Lỗi đăng ký:', error);
    res.status(500).json({ error: 'Đã xảy ra lỗi hệ thống' });
  }
}

// Đăng nhập người dùng
async function login(req, res) {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Thiếu tài khoản hoặc mật khẩu' });
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || SYSTEM_USER_IDS.includes(user.id)) {
      return res.status(400).json({ error: 'Tài khoản hoặc mật khẩu không đúng' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Tài khoản hoặc mật khẩu không đúng' });
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { status: 'online', lastSeen: new Date() }
    });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Đăng nhập thành công',
      token,
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        displayName: updatedUser.displayName,
        phone: updatedUser.phone,
        avatarUrl: updatedUser.avatarUrl,
        status: updatedUser.status
      }
    });
  } catch (error) {
    console.error('Lỗi đăng nhập:', error);
    res.status(500).json({ error: 'Đã xảy ra lỗi hệ thống' });
  }
}

// Tìm kiếm người dùng (để tạo chat / thêm vào nhóm) - Không phân biệt hoa thường trên PostgreSQL
async function searchUsers(req, res) {
  try {
    const { query } = req.query;
    const currentUserId = req.userId;

    if (!query || !String(query).trim()) {
      return res.json([]);
    }

    const cleanQuery = String(query).trim();

    const users = await prisma.user.findMany({
      where: {
        AND: [
          {
            OR: [
              { username: { contains: cleanQuery, mode: 'insensitive' } },
              { displayName: { contains: cleanQuery, mode: 'insensitive' } },
              { phone: { contains: cleanQuery, mode: 'insensitive' } }
            ]
          },
          { id: { notIn: [currentUserId, ...SYSTEM_USER_IDS] } }
        ]
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        phone: true,
        status: true
      },
      take: 15
    });

    res.json(users);
  } catch (error) {
    console.error('Lỗi tìm kiếm:', error);
    res.status(500).json({ error: 'Lỗi tìm kiếm người dùng' });
  }
}

// Lấy thông tin user hiện tại
async function getCurrentUser(req, res) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        phone: true,
        status: true
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'Không tìm thấy người dùng' });
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.json(user);
  } catch (error) {
    console.error('Lỗi lấy thông tin cá nhân:', error);
    res.status(500).json({ error: 'Lỗi máy chủ' });
  }
}

// Cập nhật trang cá nhân (tên hiển thị, avatar, số điện thoại, mật khẩu)
async function updateProfile(req, res) {
  try {
    const { displayName, phone, avatarUrl, password, newPassword } = req.body;
    const userId = req.userId;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'Không tìm thấy người dùng' });
    }

    const updatedData = {};

    if (displayName) {
      const trimmedName = String(displayName).trim();
      if (trimmedName.length < 2 || trimmedName.length > 50) {
        return res.status(400).json({ error: 'Tên hiển thị phải từ 2-50 ký tự' });
      }
      updatedData.displayName = trimmedName;
    }
    if (phone !== undefined) updatedData.phone = phone ? String(phone).trim() : null;
    if (avatarUrl) {
      if (user.avatarUrl && user.avatarUrl !== avatarUrl) {
        deleteLocalFile(user.avatarUrl).catch(() => {});
      }
      updatedData.avatarUrl = avatarUrl;
    }

    if (password && newPassword) {
      if (newPassword.length < 6 || newPassword.length > 72) {
        return res.status(400).json({ error: 'Mật khẩu mới phải từ 6-72 ký tự' });
      }
      const isMatch = await bcrypt.compare(password, user.passwordHash);
      if (!isMatch) {
        return res.status(400).json({ error: 'Mật khẩu cũ không chính xác' });
      }
      updatedData.passwordHash = await bcrypt.hash(newPassword, 10);
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updatedData,
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        phone: true,
        status: true
      }
    });

    res.json({
      message: 'Cập nhật thông tin thành công',
      user: updatedUser
    });
  } catch (error) {
    console.error('Lỗi cập nhật trang cá nhân:', error);
    res.status(500).json({ error: 'Lỗi hệ thống khi cập nhật thông tin' });
  }
}

module.exports = {
  register,
  login,
  searchUsers,
  getCurrentUser,
  updateProfile
};
