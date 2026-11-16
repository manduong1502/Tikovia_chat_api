const h = require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signUserToken } = h.requireSrc('utils/session');
const { authLimiter, loginAccountLimiter, messageLimiter, getClientIp } = h.requireSrc('middlewares/rateLimiter');

const run = async (mw, req) => {
  let code = 200;
  const res = { status: (c) => ({ json: () => { code = c; } }) };
  let nexted = false;
  await mw(req, res, () => { nexted = true; });
  return nexted ? 200 : code;
};

test('Giới hạn đăng nhập: giả mạo X-Forwarded-For không né được', async () => {
  let blocked = 0;
  for (let i = 0; i < 25; i++) {
    const code = await run(authLimiter, {
      headers: { 'x-forwarded-for': `10.0.0.${i}`, 'cf-connecting-ip': '1.2.3.4' },
      ip: '1.2.3.4',
      body: {}
    });
    if (code === 429) blocked++;
  }
  assert.equal(blocked, 5);
});

test('Giới hạn đăng nhập: dò mật khẩu 1 tài khoản từ nhiều IP bị chặn', async () => {
  let blocked = 0;
  for (let i = 0; i < 12; i++) {
    const code = await run(loginAccountLimiter, { headers: { 'cf-connecting-ip': `5.5.5.${i}` }, body: { username: 'Admin' } });
    if (code === 429) blocked++;
  }
  assert.equal(blocked, 2);
});

test('Giới hạn API: token rác ngẫu nhiên không tạo được bucket mới', async () => {
  let blocked = 0;
  for (let i = 0; i < 245; i++) {
    const code = await run(messageLimiter, { headers: { authorization: `Bearer fake.${i}.x`, 'cf-connecting-ip': '9.9.9.9' }, body: {} });
    if (code === 429) blocked++;
  }
  assert.equal(blocked, 5);
});

test('Giới hạn API: nhân viên dùng chung Wi-Fi văn phòng không bị khoá chéo', async () => {
  const tA = signUserToken('RL-A', 0);
  const tB = signUserToken('RL-B', 0);
  for (let i = 0; i < 240; i++) {
    await run(messageLimiter, { headers: { authorization: `Bearer ${tA}`, 'cf-connecting-ip': '8.8.8.8' }, body: {} });
  }
  const codeB = await run(messageLimiter, { headers: { authorization: `Bearer ${tB}`, 'cf-connecting-ip': '8.8.8.8' }, body: {} });
  assert.equal(codeB, 200);
});

test('Lấy IP: ưu tiên CF-Connecting-IP thay vì X-Forwarded-For', () => {
  assert.equal(
    getClientIp({ headers: { 'cf-connecting-ip': '7.7.7.7', 'x-forwarded-for': '6.6.6.6' }, ip: '1.1.1.1' }),
    '7.7.7.7'
  );
});
