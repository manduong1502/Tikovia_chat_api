/**
 * Bộ khung kiểm thử: giả lập CSDL (Prisma), Redis và logger để chạy kiểm thử phân quyền
 * mà KHÔNG cần PostgreSQL/Redis thật. Phải require file này TRƯỚC mọi module trong src/.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const SRC = path.join(__dirname, '..', 'src');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'chattikovia-test-secret';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chattikovia-test-'));

function mockModule(relPath, exportsObj) {
  const resolved = require.resolve(path.join(SRC, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const noop = () => {};
mockModule('utils/logger', { info: noop, warn: noop, error: noop, debug: noop });
mockModule('utils/redis', { redis: null, isRedisReady: () => false });

// --- Prisma giả lập: mỗi lời gọi prisma.<model>.<method>() được ghi lại và trả về giá trị do test quy định ---
const impl = {};
const calls = [];

function defaultResult(method) {
  if (method === 'findMany') return [];
  if (method === 'count') return 0;
  if (method === 'deleteMany' || method === 'updateMany' || method === 'createMany') return { count: 0 };
  return null;
}

const prisma = new Proxy(
  {},
  {
    get(_, model) {
      if (model === '$transaction') {
        return async (arg) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg));
      }
      if (model === '$queryRaw' || model === '$executeRaw') {
        return async () => impl[model] ? impl[model]() : [];
      }
      if (typeof model === 'symbol' || model === 'then') return undefined;
      return new Proxy(
        {},
        {
          get(__, method) {
            return async (...args) => {
              calls.push({ model, method, args });
              const fn = impl[`${model}.${method}`];
              return fn ? fn(...args) : defaultResult(method);
            };
          }
        }
      );
    }
  }
);
mockModule('db', prisma);

function setMock(key, fn) {
  impl[key] = fn;
}

function resetMocks() {
  Object.keys(impl).forEach((k) => delete impl[k]);
  calls.length = 0;
}

function findCalls(model, method) {
  return calls.filter((c) => c.model === model && c.method === method);
}

/**
 * Tạo req/res giả cho Express. `done` resolve khi controller trả lời (res.json) hoặc gọi next(err).
 */
function mockHttp({ userId = 'U1', params = {}, body = {}, query = {}, headers = {}, io = null } = {}) {
  let resolveDone;
  const done = new Promise((r) => {
    resolveDone = r;
  });
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
    json(payload) {
      this.body = payload;
      resolveDone(this);
      return this;
    }
  };
  const req = {
    userId,
    params,
    body,
    query,
    headers,
    app: { get: (key) => (key === 'io' ? io : null) }
  };
  const next = (err) => {
    res.statusCode = err ? 500 : res.statusCode;
    res.error = err;
    resolveDone(res);
  };
  return { req, res, next, done };
}

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  SRC,
  prisma,
  setMock,
  resetMocks,
  findCalls,
  mockHttp,
  tick,
  requireSrc: (rel) => require(path.join(SRC, rel))
};
