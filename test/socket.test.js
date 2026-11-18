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
  const rooms = new Set();
  const socket = {
    id: `sock-${userId}`,
    userId,
    rooms,
    handshake: { headers: {} },
    join: (room) => rooms.add(room),
    to: (room) => ({ emit: (ev, payload) => broadcast.push({ room, ev, payload, via: 'socket' }) }),
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

test('Đang gõ: người ngoài phòng không phát được tín hiệu', async () => {
  h.setMock('conversationMember.findUnique', async () => null);
  const { fire, broadcast } = connect('OUTSIDER');
  await fire('typing', { conversationId: 'C1', isTyping: true });
  assert.equal(broadcast.filter((b) => b.ev === 'user-typing').length, 0);
});

test('Đang gõ: đã vào phòng thì phát ngay, không truy vấn CSDL', async () => {
  h.setMock('conversationMember.findUnique', async () => ({}));
  const { fire, broadcast } = connect('A');
  await fire('join-conversation', 'C1');
  const queriesAfterJoin = h.findCalls('conversationMember', 'findUnique').length;
  await fire('typing', { conversationId: 'C1', isTyping: true });
  await fire('typing', { conversationId: 'C1', isTyping: false });
  assert.equal(h.findCalls('conversationMember', 'findUnique').length, queriesAfterJoin, 'không thêm truy vấn nào');
  const typingEvents = broadcast.filter((b) => b.ev === 'user-typing');
  assert.equal(typingEvents.length, 2);
  assert.equal(typingEvents[0].room, 'C1');
});

test('Gọi điện WebRTC: chuyển tiếp SDP/ICE chính xác giữa 2 thiết bị và chặn người lạ chèn gói tin', async () => {
  let connectionHandler;
  const broadcast = [];
  const io = {
    on: (ev, cb) => {
      if (ev === 'connection') connectionHandler = cb;
    },
    to: (room) => ({ emit: (ev, payload) => broadcast.push({ room, ev, payload }) }),
    emit: () => {}
  };
  const userSocketMap = new Map();
  const activeCalls = new Map();
  setupSocketHandlers(io, h.prisma, userSocketMap, activeCalls);

  const attachUser = (userId) => {
    const handlers = {};
    const socket = {
      id: `sock-${userId}`,
      userId,
      rooms: new Set(),
      handshake: { headers: {} },
      join: () => {},
      to: () => ({ emit: () => {} }),
      emit: () => {},
      on(ev, listener) {
        handlers[ev] = listener;
      }
    };
    connectionHandler(socket);
    const fire = async (ev, payload) => {
      await handlers[ev](payload);
      await h.tick(20);
    };
    return { socket, fire };
  };

  h.setMock('conversationMember.findUnique', async () => ({}));
  h.setMock('user.findUnique', async ({ where }) => ({
    id: where.id,
    displayName: `User ${where.id}`,
    avatarUrl: null
  }));
  h.setMock('user.update', async () => ({}));

  const caller = attachUser('CALLER');
  const receiver = attachUser('RECEIVER');
  const intruder = attachUser('INTRUDER');

  await caller.fire('register-user', 'CALLER');
  await receiver.fire('register-user', 'RECEIVER');
  await intruder.fire('register-user', 'INTRUDER');

  await caller.fire('call-user', {
    userToCall: 'RECEIVER',
    conversationId: 'C1',
    isVideo: false
  });
  assert.ok(broadcast.some((b) => b.room === 'sock-RECEIVER' && b.ev === 'incoming-call'));

  await receiver.fire('answer-call', {
    to: 'CALLER',
    signal: { ready: true }
  });
  const acceptedEvt = broadcast.find((b) => b.room === 'sock-CALLER' && b.ev === 'call-accepted');
  assert.ok(acceptedEvt, 'người gọi nhận được tín hiệu bắt máy');
  assert.equal(acceptedEvt.payload.responderSocketId, 'sock-RECEIVER');

  // Kẻ lạ cố chèn gói WebRTC giả mạo vào cuộc gọi -> phải bị chặn hoàn toàn
  await intruder.fire('webrtc-signal', {
    to: 'RECEIVER',
    signal: { type: 'offer', sdp: 'fake-sdp' }
  });
  assert.equal(
    broadcast.filter((b) => b.ev === 'webrtc-signal' && b.payload?.from === 'INTRUDER').length,
    0,
    'chặn tuyệt đối người ngoài cuộc gọi gửi webrtc-signal'
  );

  // Người gọi gửi SDP Offer -> đến đúng sock-RECEIVER
  await caller.fire('webrtc-signal', {
    to: 'RECEIVER',
    targetSocketId: 'sock-RECEIVER',
    signal: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0...' } }
  });
  assert.ok(
    broadcast.some(
      (b) => b.room === 'sock-RECEIVER' && b.ev === 'webrtc-signal' && b.payload?.signal?.type === 'offer'
    )
  );

  // Người nghe gửi SDP Answer -> quay về đúng sock-CALLER
  await receiver.fire('webrtc-signal', {
    to: 'CALLER',
    targetSocketId: 'sock-CALLER',
    signal: { type: 'answer', sdp: { type: 'answer', sdp: 'v=0...' } }
  });
  assert.ok(
    broadcast.some(
      (b) => b.room === 'sock-CALLER' && b.ev === 'webrtc-signal' && b.payload?.signal?.type === 'answer'
    )
  );
});

test('Thu hồi tin nhắn: phát sự kiện thu hồi và kích hoạt Web Push xoá thông báo cho thành viên khác', async () => {
  h.setMock('conversationMember.findUnique', async () => ({}));
  h.setMock('conversationMember.findMany', async () => [{ userId: 'A' }, { userId: 'B' }]);
  h.setMock('message.findUnique', async () => ({
    id: 'MSG-1',
    conversationId: 'C1',
    senderId: 'A',
    type: 'text',
    content: 'tin nhắn nhầm'
  }));
  h.setMock('message.update', async () => ({}));
  h.setMock('conversation.findUnique', async () => ({
    id: 'C1',
    isGroup: false,
    name: null,
    members: [{ userId: 'B', isMuted: false }]
  }));
  h.setMock('user.findUnique', async () => ({ displayName: 'Nguyễn A', avatarUrl: null }));
  h.setMock('pushSubscription.findMany', async () => []);

  const { fire, broadcast } = connect('A');
  await fire('recall-message', { messageId: 'MSG-1', conversationId: 'C1' });

  assert.ok(h.findCalls('message', 'update').length === 1);
  // Phải truy vấn pushSubscription của người nhận B để gửi lệnh gỡ thông báo trên màn hình khóa
  const pushQueries = h.findCalls('pushSubscription', 'findMany');
  assert.ok(pushQueries.some((q) => q.args[0]?.where?.userId === 'B'));
  assert.ok(broadcast.some((b) => b.ev === 'message-recalled'));
});
