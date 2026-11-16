const h = require('./helpers');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const { isValidAvatarUrl, deleteLocalFile, BASE_UPLOAD_DIR } = h.requireSrc('utils/storage');
const { isValidWebPushEndpoint } = h.requireSrc('controllers/pushController');
const { signUserToken, verifyUserToken } = h.requireSrc('utils/session');

beforeEach(() => h.resetMocks());

test('Ảnh đại diện: chỉ chấp nhận ảnh nội bộ hợp lệ hoặc HTTPS', () => {
  assert.ok(isValidAvatarUrl('/api/uploads/avatars/1731234-abc123.jpg'));
  assert.ok(isValidAvatarUrl('/api/uploads/images/2026-11/1731234-abc.png'));
  assert.ok(isValidAvatarUrl('https://api.dicebear.com/7.x/adventurer/svg?seed=x'));
  assert.ok(isValidAvatarUrl(''));
  assert.ok(!isValidAvatarUrl('/api/uploads/files/2026-11/hopdong.pdf'), 'không được trỏ sang tệp đính kèm');
  assert.ok(!isValidAvatarUrl('/api/uploads/avatars/../.vapid.json'));
  assert.ok(!isValidAvatarUrl('/api/uploads/avatars/.vapid.json'));
  assert.ok(!isValidAvatarUrl('javascript:alert(1)'));
  assert.ok(!isValidAvatarUrl('http://evil.com/a.png'));
  assert.ok(!isValidAvatarUrl('/api/uploads/images/2026-11/x.pdf'));
});

test('Push endpoint: chặn SSRF vào mạng nội bộ / tên miền giả mạo', () => {
  assert.ok(isValidWebPushEndpoint('https://fcm.googleapis.com/fcm/send/abc:xyz'));
  assert.ok(isValidWebPushEndpoint('https://web.push.apple.com/QGx123'));
  assert.ok(isValidWebPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc'));
  assert.ok(!isValidWebPushEndpoint('https://localhost:4003/x'));
  assert.ok(!isValidWebPushEndpoint('https://192.168.1.200:5000/x'));
  assert.ok(!isValidWebPushEndpoint('http://fcm.googleapis.com/fcm/send/x'));
  assert.ok(!isValidWebPushEndpoint('https://fcm.googleapis.com.evil.com/x'));
  assert.ok(!isValidWebPushEndpoint('https://evilpush.apple.com/x'));
});

test('Xoá tệp: không thể xoá tệp ngoài thư mục được phép', async () => {
  fs.mkdirSync(path.join(BASE_UPLOAD_DIR, 'avatars'), { recursive: true });
  fs.mkdirSync(path.join(BASE_UPLOAD_DIR, 'files', '2026-11'), { recursive: true });
  const victim = path.join(BASE_UPLOAD_DIR, 'files', '2026-11', 'victim.pdf');
  const avatar = path.join(BASE_UPLOAD_DIR, 'avatars', 'old.jpg');
  const vapid = path.join(BASE_UPLOAD_DIR, '.vapid.json');
  fs.writeFileSync(victim, 'x');
  fs.writeFileSync(avatar, 'x');
  fs.writeFileSync(vapid, '{}');

  assert.equal(await deleteLocalFile('/api/uploads/files/2026-11/victim.pdf', 'avatars'), false);
  assert.equal(await deleteLocalFile('/api/uploads/.vapid.json'), false);
  assert.equal(await deleteLocalFile('/api/uploads/avatars/%2e%2e/files/2026-11/victim.pdf', 'avatars'), false);
  assert.ok(fs.existsSync(victim) && fs.existsSync(vapid));
  assert.equal(await deleteLocalFile('/api/uploads/avatars/old.jpg', 'avatars'), true);
  assert.ok(!fs.existsSync(avatar));
});

test('Phiên đăng nhập: token cũ bị từ chối sau khi đổi mật khẩu', async () => {
  h.setMock('user.findUnique', async () => ({ tokenVersion: 1 }));
  const oldToken = signUserToken('USER-REVOKE', 0);
  await assert.rejects(() => verifyUserToken(oldToken), /TOKEN_REVOKED/);

  const newToken = signUserToken('USER-REVOKE', 1);
  const session = await verifyUserToken(newToken);
  assert.equal(session.userId, 'USER-REVOKE');
});

test('Phiên đăng nhập: token phát hành trước bản cập nhật (không có tv) vẫn hợp lệ', async () => {
  h.setMock('user.findUnique', async () => ({ tokenVersion: 0 }));
  const legacy = jwt.sign({ userId: 'USER-LEGACY' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  const session = await verifyUserToken(legacy);
  assert.equal(session.userId, 'USER-LEGACY');
});

test('Phiên đăng nhập: tài khoản đã bị xoá thì token không còn hiệu lực', async () => {
  h.setMock('user.findUnique', async () => null);
  await assert.rejects(() => verifyUserToken(signUserToken('USER-DELETED', 0)), /USER_NOT_FOUND/);
});

test('Middleware xác thực: trả mã SESSION_REVOKED cho máy đã bị đăng xuất', async () => {
  const verifyToken = h.requireSrc('middlewares/authMiddleware');
  h.setMock('user.findUnique', async () => ({ tokenVersion: 3 }));
  const token = signUserToken('USER-MW', 2);
  const { req, res, done } = h.mockHttp({ headers: { authorization: `Bearer ${token}` } });
  let nextCalled = false;
  verifyToken(req, res, () => {
    nextCalled = true;
  });
  await done;
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'SESSION_REVOKED');
});
