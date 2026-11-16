const h = require('./helpers');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const setupSocketHandlers = h.requireSrc('socketHandlers');

beforeEach(() => h.resetMocks());

/**
 * Tạo kết nối Socket giả cho người dùng `userId` và trả về hàm gọi sự kiện + danh sách sự kiện server phát ra
 */
function connect(userId) {
  let connectionHandler;
  const broadcast = [];
  const io = {
    on: (ev, cb) => {
      if (ev === 'connection') connectionHandler = cb;
    },
    to: (room) => ({ emit: (ev, payload) => broadcast.push({ room, ev, payload }) }),
    emit: () => {}
  };
  setupSocketHandlers(io, h.prisma, new Map(), new Map());

  const handlers = {};
  const emitted = [];
  const socket = {
    id: `sock-${userId}`,
    userId,
    handshake: { headers: {} },
    join: () => {},
    emit: (ev, payload) => emitted.push({ ev, payload }),
    on(ev, listener) {
      handlers[ev] = listener;
    }
  };
  connectionHandler(socket);

  const fire = async (ev, payload) => {
    handlers[ev](payload);
    await h.tick(25);
  };
  return { fire, emitted, broadcast };
}

const convWithMembers = (id, userIds) => ({
  id,
  isGroup: false,
  name: null,
  members: userIds.map((u) => ({ userId: u, isMuted: false, user: { id: u, username: u, displayName: u } }))
});

test('Gửi tin nhắn: người ngoài phòng không gửi được', async () => {
  h.setMock('conversation.findUnique', async () => convWithMembers('C1', ['A', 'B']));
  const { fire, emitted } = connect('OUTSIDER');
  await fire('send-message', { conversationId: 'C1', type: 'text', content: 'xin chào' });
  assert.equal(h.findCalls('message', 'create').length, 0);
  assert.ok(emitted.some((e) => e.ev === 'error-response'));
});

test('Gửi tin nhắn: không thể giả mạo tin nhắn "hệ thống"', async () => {
  const { fire, emitted } = connect('A');
  await fire('send-message', { conversationId: 'C1', type: 'system', content: 'Admin đã cấp quyền cho bạn' });
  assert.equal(h.findCalls('message', 'create').length, 0);
  assert.ok(emitted.some((e) => e.ev === 'error-response'));
});

test('Gửi tệp: chặn đường dẫn javascript: / data:', async () => {
  const { fire } = connect('A');
  await fire('send-message', { conversationId: 'C1', type: 'image', content: 'javascript:alert(1)' });
  await fire('send-message', { conversationId: 'C1', type: 'file', content: 'data:text/html,<script>' });
  assert.equal(h.findCalls('message', 'create').length, 0);
});

test('Trả lời tin nhắn: không thể trích dẫn tin nhắn của phòng bí mật khác (IDOR)', async () => {
  h.setMock('conversation.findUnique', async () => convWithMembers('C1', ['A', 'B']));
  h.setMock('message.findUnique', async () => ({ id: 'SECRET-MSG', conversationId: 'C-SECRET' }));
  h.setMock('message.create', async ({ data }) => ({ id: 'NEW', ...data, sender: { id: 'A', displayName: 'A' } }));
  const { fire } = connect('A');
  await fire('send-message', { conversationId: 'C1', type: 'text', content: 'hi', replyToId: 'SECRET-MSG' });
  const created = h.findCalls('message', 'create')[0];
  assert.ok(created, 'tin nhắn vẫn được gửi');
  assert.equal(created.args[0].data.replyToId, null, 'liên kết trả lời phải bị loại bỏ');
});

test('Gửi tin nhắn: đồng bộ "đã đọc" sang các thiết bị khác của người gửi', async () => {
  h.setMock('conversation.findUnique', async () => convWithMembers('C1', ['A', 'B']));
  h.setMock('message.create', async ({ data }) => ({ id: 'NEW', ...data, sender: { id: 'A', displayName: 'A' } }));
  const { fire, broadcast } = connect('A');
  await fire('send-message', { conversationId: 'C1', type: 'text', content: 'ok' });
  assert.ok(broadcast.some((b) => b.room === 'user-A' && b.ev === 'conversation-read-sync'));
});

test('Gọi điện: tên người gọi lấy từ CSDL, không tin dữ liệu client gửi lên', async () => {
  h.setMock('conversationMember.findUnique', async () => ({}));
  h.setMock('user.findUnique', async () => ({ displayName: 'Nguyễn Văn A', avatarUrl: null }));
  const { fire } = connect('A');
  await fire('call-user', { userToCall: 'B', conversationId: 'C1', callerName: 'Giám đốc', isVideo: false, signalData: {} });
  // Không có socket nào của B đang mở, nhưng hệ thống vẫn phải tra tên từ CSDL
  assert.ok(h.findCalls('user', 'findUnique').length >= 1);
});

test('Gọi điện: không thể tự gọi cho chính mình', async () => {
  const { fire } = connect('A');
  await fire('call-user', { userToCall: 'A', conversationId: 'C1', signalData: {} });
  assert.equal(h.findCalls('conversationMember', 'findUnique').length, 0);
});
