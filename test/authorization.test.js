const h = require('./helpers');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const chat = h.requireSrc('controllers/chatController');
const auth = h.requireSrc('controllers/authController');
const push = h.requireSrc('controllers/pushController');

beforeEach(() => h.resetMocks());

const member = (conversationId, userId, extra = {}) => ({ conversationId, userId, role: 'member', ...extra });

test('Xem tin nhắn: người ngoài phòng bị chặn 403', async () => {
  h.setMock('conversationMember.findUnique', async () => null);
  const { req, res, next, done } = h.mockHttp({ userId: 'OUTSIDER', params: { conversationId: 'C1' } });
  chat.getMessages(req, res, next);
  await done;
  assert.equal(res.statusCode, 403);
  assert.equal(h.findCalls('message', 'findMany').length, 0, 'không được truy vấn tin nhắn');
});

test('Đổi biệt danh: không thể sửa biệt danh người không thuộc phòng', async () => {
  h.setMock('conversationMember.findUnique', async ({ where }) =>
    where.conversationId_userId.userId === 'U1' ? member('C1', 'U1') : null
  );
  const { req, res, next, done } = h.mockHttp({
    userId: 'U1',
    params: { conversationId: 'C1' },
    body: { targetUserId: 'STRANGER', nickname: 'abc' }
  });
  chat.setNickname(req, res, next);
  await done;
  assert.equal(res.statusCode, 403);
  assert.equal(h.findCalls('conversationMember', 'update').length, 0);
});

test('Nhắc hẹn: không thể gắn vào tin nhắn của phòng khác', async () => {
  h.setMock('message.findUnique', async () => ({ id: 'M-SECRET', conversationId: 'C-SECRET' }));
  h.setMock('conversationMember.findUnique', async () => member('C1', 'U1'));
  const { req, res, next, done } = h.mockHttp({
    userId: 'U1',
    body: { conversationId: 'C1', messageId: 'M-SECRET', title: 'Họp', remindAt: new Date(Date.now() + 60000).toISOString() }
  });
  chat.createReminder(req, res, next);
  await done;
  assert.equal(res.statusCode, 403);
  assert.equal(h.findCalls('reminder', 'create').length, 0);
});

test('Xoá thành viên: chỉ Trưởng nhóm được mời người khác ra khỏi nhóm', async () => {
  h.setMock('conversation.findUnique', async () => ({
    id: 'G1',
    isGroup: true,
    createdById: 'LEADER',
    members: [member('G1', 'LEADER'), member('G1', 'U1'), member('G1', 'U2')]
  }));
  const { req, res, next, done } = h.mockHttp({ userId: 'U1', params: { conversationId: 'G1', userId: 'U2' } });
  chat.removeGroupMember(req, res, next);
  await done;
  assert.equal(res.statusCode, 403);
  assert.equal(h.findCalls('conversationMember', 'delete').length, 0);
});

test('Sửa thông tin nhóm: thành viên thường bị chặn, Trưởng nhóm không thể đặt ảnh trỏ sang tệp đính kèm', async () => {
  const group = {
    id: 'G1',
    isGroup: true,
    createdById: 'LEADER',
    avatarUrl: null,
    name: 'Kho',
    members: [member('G1', 'LEADER'), member('G1', 'U1')]
  };
  h.setMock('conversation.findUnique', async () => group);

  let ctx = h.mockHttp({ userId: 'U1', params: { conversationId: 'G1' }, body: { name: 'Hack' } });
  chat.updateGroupDetails(ctx.req, ctx.res, ctx.next);
  await ctx.done;
  assert.equal(ctx.res.statusCode, 403);

  ctx = h.mockHttp({
    userId: 'LEADER',
    params: { conversationId: 'G1' },
    body: { avatarUrl: '/api/uploads/files/2026-11/hop-dong.pdf' }
  });
  chat.updateGroupDetails(ctx.req, ctx.res, ctx.next);
  await ctx.done;
  assert.equal(ctx.res.statusCode, 400);
  assert.equal(h.findCalls('conversation', 'update').length, 0);
});

test('Tạo cuộc trò chuyện: bỏ qua ID không tồn tại và tài khoản hệ thống ảo', async () => {
  h.setMock('user.findMany', async () => []);
  const { req, res, next, done } = h.mockHttp({
    userId: 'U1',
    body: { isGroup: true, name: 'Test', memberIds: ['GHOST', '00000000-0000-0000-0000-000000000001'] }
  });
  chat.createConversation(req, res, next);
  await done;
  assert.equal(res.statusCode, 400);
  assert.equal(h.findCalls('conversation', 'create').length, 0);
  const where = h.findCalls('user', 'findMany')[0].args[0].where;
  assert.ok(where.id.notIn.includes('00000000-0000-0000-0000-000000000001'));
});

test('Huỷ thông báo đẩy: chỉ xoá được thiết bị của chính mình', async () => {
  const { req, res, done } = h.mockHttp({ userId: 'U1', body: { endpoint: 'https://fcm.googleapis.com/fcm/send/VICTIM' } });
  push.unsubscribe(req, res);
  await done;
  const del = h.findCalls('pushSubscription', 'deleteMany')[0];
  assert.equal(del.args[0].where.userId, 'U1');
});

test('Đăng ký thông báo đẩy: từ chối endpoint trỏ vào mạng nội bộ', async () => {
  const { req, res, done } = h.mockHttp({
    userId: 'U1',
    body: { subscription: { endpoint: 'https://127.0.0.1:4003/hook', keys: { p256dh: 'a', auth: 'b' } } }
  });
  push.subscribe(req, res);
  await done;
  assert.equal(res.statusCode, 400);
  assert.equal(h.findCalls('pushSubscription', 'upsert').length, 0);
});

test('Đăng ký tài khoản: mật khẩu tối thiểu 8 ký tự', async () => {
  const { req, res, done } = h.mockHttp({ body: { username: 'nhanvien1', password: '1234567', displayName: 'Nhân viên' } });
  auth.register(req, res);
  await done;
  assert.equal(res.statusCode, 400);
  assert.equal(h.findCalls('user', 'create').length, 0);
});

test('Hồ sơ: đổi tên không bị chặn bởi ảnh đại diện cũ (dữ liệu cũ vẫn dùng được)', async () => {
  const legacyAvatar = 'http://localhost:5000/api/uploads/old-format.png';
  h.setMock('user.findUnique', async () => ({ id: 'U1', avatarUrl: legacyAvatar, passwordHash: 'x' }));
  h.setMock('user.update', async ({ data }) => ({ id: 'U1', username: 'u1', displayName: data.displayName, avatarUrl: legacyAvatar, phone: null, status: 'online', tokenVersion: 0 }));
  const { req, res, done } = h.mockHttp({ userId: 'U1', body: { displayName: 'Tên mới', avatarUrl: legacyAvatar } });
  auth.updateProfile(req, res);
  await done;
  assert.equal(res.statusCode, 200);
  assert.equal(h.findCalls('user', 'update')[0].args[0].data.avatarUrl, undefined, 'không được ghi đè ảnh cũ');
});

test('Đổi mật khẩu: cấp token mới, thu hồi phiên cũ và gỡ thông báo của máy khác', async () => {
  const passwordHash = await bcrypt.hash('MatKhauCu123', 4);
  h.setMock('user.findUnique', async () => ({ id: 'U-PW', avatarUrl: null, passwordHash }));
  h.setMock('user.update', async () => ({ id: 'U-PW', username: 'u', displayName: 'U', avatarUrl: null, phone: null, status: 'online', tokenVersion: 5 }));

  const disconnected = [];
  const logoutNotified = [];
  const fakeSockets = [
    { id: 'this-device', data: { tokenVersion: 4 }, emit: (ev) => logoutNotified.push(['this-device', ev]), disconnect: () => disconnected.push('this-device') },
    { id: 'old-phone', data: { tokenVersion: 4 }, emit: (ev) => logoutNotified.push(['old-phone', ev]), disconnect: () => disconnected.push('old-phone') }
  ];
  const io = { in: () => ({ fetchSockets: async () => fakeSockets }) };

  const { req, res, done } = h.mockHttp({
    userId: 'U-PW',
    io,
    body: {
      password: 'MatKhauCu123',
      newPassword: 'MatKhauMoi456',
      currentSocketId: 'this-device',
      currentEndpoint: 'https://fcm.googleapis.com/fcm/send/THIS'
    }
  });
  auth.updateProfile(req, res);
  await done;

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token, 'thiết bị hiện tại nhận token mới');
  assert.equal(jwt.decode(res.body.token).tv, 5);
  assert.equal(res.body.user.tokenVersion, undefined, 'không lộ tokenVersion ra client');
  assert.deepEqual(h.findCalls('user', 'update')[0].args[0].data.tokenVersion, { increment: 1 });

  const del = h.findCalls('pushSubscription', 'deleteMany')[0].args[0].where;
  assert.equal(del.userId, 'U-PW');
  assert.deepEqual(del.endpoint, { not: 'https://fcm.googleapis.com/fcm/send/THIS' });

  assert.deepEqual(disconnected.sort(), ['old-phone', 'this-device']);
  assert.deepEqual(logoutNotified, [['old-phone', 'force-logout']], 'chỉ máy cũ bị báo đăng xuất');
});

test('Đổi mật khẩu: sai mật khẩu cũ thì không thay đổi gì', async () => {
  const passwordHash = await bcrypt.hash('MatKhauCu123', 4);
  h.setMock('user.findUnique', async () => ({ id: 'U1', avatarUrl: null, passwordHash }));
  const { req, res, done } = h.mockHttp({ userId: 'U1', body: { password: 'SaiMatKhau', newPassword: 'MatKhauMoi456' } });
  auth.updateProfile(req, res);
  await done;
  assert.equal(res.statusCode, 400);
  assert.equal(h.findCalls('user', 'update').length, 0);
});
