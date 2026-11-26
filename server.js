const express = require("express");
const http = require("http");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!JWT_SECRET) console.warn("WARNING: Set JWT_SECRET in Render environment variables.");
if (!DATABASE_URL) console.warn("WARNING: Set DATABASE_URL in Render environment variables.");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && !DATABASE_URL.includes("localhost")
    ? { rejectUnauthorized: false }
    : false
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "6mb" }));
app.use(express.static(path.join(__dirname)));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(24) UNIQUE NOT NULL,
      display_name VARCHAR(40) NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chat_groups (
      id SERIAL PRIMARY KEY,
      name VARCHAR(50) NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invite_code VARCHAR(16) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      group_id INTEGER REFERENCES chat_groups(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      kind VARCHAR(10) NOT NULL DEFAULT 'text',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((recipient_id IS NOT NULL AND group_id IS NULL) OR (recipient_id IS NULL AND group_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS messages_private_idx ON messages(sender_id, recipient_id, created_at);
    CREATE INDEX IF NOT EXISTS messages_group_idx ON messages(group_id, created_at);
  `);
}

function makeToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "14d" });
}
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}
function getToken(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}
function requireAuth(req, res, next) {
  try {
    if (!JWT_SECRET) throw new Error("JWT_SECRET is not configured");
    req.user = verifyToken(getToken(req));
    next();
  } catch {
    res.status(401).json({ error: "برای ادامه وارد حساب خودت شو." });
  }
}
function safeUser(row) {
  return { id: row.id, username: row.username, displayName: row.display_name };
}
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.get("/api/health", (req, res) => res.json({ ok: true, service: "Scroll Chat" }));

app.post("/api/register", authLimiter, asyncRoute(async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const displayName = String(req.body.displayName || "").trim();
  const password = String(req.body.password || "");
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: "نام کاربری باید ۳ تا ۲۴ حرف انگلیسی، عدد یا _ باشد." });
  if (displayName.length < 2 || displayName.length > 40) return res.status(400).json({ error: "نام نمایشی باید بین ۲ تا ۴۰ حرف باشد." });
  if (password.length < 8) return res.status(400).json({ error: "رمز عبور باید حداقل ۸ کاراکتر باشد." });
  const hash = await bcrypt.hash(password, 12);
  try {
    const result = await pool.query(
      "INSERT INTO users(username, display_name, password_hash) VALUES($1,$2,$3) RETURNING id, username, display_name",
      [username, displayName, hash]
    );
    const user = safeUser(result.rows[0]);
    res.status(201).json({ token: makeToken(user), user });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "این نام کاربری قبلاً گرفته شده." });
    throw e;
  }
}));

app.post("/api/login", authLimiter, asyncRoute(async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const result = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
  const row = result.rows[0];
  if (!row || !(await bcrypt.compare(password, row.password_hash))) return res.status(401).json({ error: "نام کاربری یا رمز عبور اشتباه است." });
  const user = safeUser(row);
  res.json({ token: makeToken(user), user });
}));

app.get("/api/me", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query("SELECT id, username, display_name FROM users WHERE id=$1", [req.user.id]);
  if (!result.rows[0]) return res.status(404).json({ error: "حساب پیدا نشد." });
  res.json({ user: safeUser(result.rows[0]) });
}));

app.get("/api/users", requireAuth, asyncRoute(async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const result = await pool.query(
    `SELECT id, username, display_name FROM users
     WHERE id <> $1 AND ($2 = '' OR username ILIKE $3 OR display_name ILIKE $3)
     ORDER BY display_name LIMIT 50`,
    [req.user.id, q, `%${q}%`]
  );
  res.json({ users: result.rows.map(safeUser) });
}));

app.get("/api/groups", requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT g.id, g.name, g.invite_code,
      (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id=g.id)::int AS members
     FROM chat_groups g JOIN group_members gm ON gm.group_id=g.id
     WHERE gm.user_id=$1 ORDER BY g.created_at DESC`,
    [req.user.id]
  );
  res.json({ groups: result.rows });
}));

app.post("/api/groups", requireAuth, asyncRoute(async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (name.length < 2 || name.length > 50) return res.status(400).json({ error: "نام گروه باید بین ۲ تا ۵۰ کاراکتر باشد." });
  const code = crypto.randomBytes(5).toString("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const g = await client.query(
      "INSERT INTO chat_groups(name, owner_id, invite_code) VALUES($1,$2,$3) RETURNING id, name, invite_code",
      [name, req.user.id, code]
    );
    await client.query("INSERT INTO group_members(group_id,user_id) VALUES($1,$2)", [g.rows[0].id, req.user.id]);
    await client.query("COMMIT");
    res.status(201).json({ group: { ...g.rows[0], members: 1 } });
  } catch (e) {
    await client.query("ROLLBACK"); throw e;
  } finally { client.release(); }
}));

app.post("/api/groups/join", requireAuth, asyncRoute(async (req, res) => {
  const code = String(req.body.code || "").trim();
  const g = await pool.query("SELECT id FROM chat_groups WHERE invite_code=$1", [code]);
  if (!g.rows[0]) return res.status(404).json({ error: "کد دعوت معتبر نیست." });
  await pool.query("INSERT INTO group_members(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [g.rows[0].id, req.user.id]);
  res.json({ ok: true });
}));

app.get("/api/messages/private/:userId", requireAuth, asyncRoute(async (req, res) => {
  const other = Number(req.params.userId);
  if (!Number.isInteger(other) || other === req.user.id) return res.status(400).json({ error: "گفت‌وگوی نامعتبر." });
  const result = await pool.query(
    `SELECT m.id,m.sender_id,m.recipient_id,m.body,m.kind,m.created_at,u.display_name AS sender_name
     FROM messages m JOIN users u ON u.id=m.sender_id
     WHERE m.group_id IS NULL AND
       ((m.sender_id=$1 AND m.recipient_id=$2) OR (m.sender_id=$2 AND m.recipient_id=$1))
     ORDER BY m.created_at DESC LIMIT 100`,
    [req.user.id, other]
  );
  res.json({ messages: result.rows.reverse() });
}));

app.get("/api/messages/group/:groupId", requireAuth, asyncRoute(async (req, res) => {
  const groupId = Number(req.params.groupId);
  const member = await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2", [groupId, req.user.id]);
  if (!member.rowCount) return res.status(403).json({ error: "عضو این گروه نیستی." });
  const result = await pool.query(
    `SELECT m.id,m.sender_id,m.group_id,m.body,m.kind,m.created_at,u.display_name AS sender_name
     FROM messages m JOIN users u ON u.id=m.sender_id
     WHERE m.group_id=$1 ORDER BY m.created_at DESC LIMIT 100`,
    [groupId]
  );
  res.json({ messages: result.rows.reverse() });
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "خطای سرور. تنظیمات دیتابیس و Render را بررسی کن." });
});

const onlineUsers = new Map();
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    socket.user = verifyToken(token);
    next();
  } catch { next(new Error("unauthorized")); }
});

io.on("connection", (socket) => {
  const userId = Number(socket.user.id);
  onlineUsers.set(userId, (onlineUsers.get(userId) || 0) + 1);
  socket.join(`user:${userId}`);
  io.emit("presence", { userId, online: true });

  socket.on("private:send", async (data, ack) => {
    try {
      const recipientId = Number(data && data.recipientId);
      const body = String(data && data.body || "");
      const kind = data && data.kind === "image" ? "image" : "text";
      if (!Number.isInteger(recipientId) || recipientId === userId || !body || body.length > 5_000_000) throw new Error("پیام نامعتبر است.");
      const exists = await pool.query("SELECT 1 FROM users WHERE id=$1", [recipientId]);
      if (!exists.rowCount) throw new Error("کاربر پیدا نشد.");
      const saved = await pool.query(
        "INSERT INTO messages(sender_id,recipient_id,body,kind) VALUES($1,$2,$3,$4) RETURNING id,sender_id,recipient_id,body,kind,created_at",
        [userId, recipientId, body, kind]
      );
      const message = { ...saved.rows[0], sender_name: socket.user.username };
      io.to(`user:${recipientId}`).emit("private:new", message);
      socket.emit("private:new", message);
      if (ack) ack({ ok: true });
    } catch (e) { if (ack) ack({ ok: false, error: e.message }); }
  });

  socket.on("group:send", async (data, ack) => {
    try {
      const groupId = Number(data && data.groupId);
      const body = String(data && data.body || "");
      const kind = data && data.kind === "image" ? "image" : "text";
      if (!Number.isInteger(groupId) || !body || body.length > 5_000_000) throw new Error("پیام نامعتبر است.");
      const member = await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2", [groupId, userId]);
      if (!member.rowCount) throw new Error("عضو این گروه نیستی.");
      const saved = await pool.query(
        "INSERT INTO messages(sender_id,group_id,body,kind) VALUES($1,$2,$3,$4) RETURNING id,sender_id,group_id,body,kind,created_at",
        [userId, groupId, body, kind]
      );
      const u = await pool.query("SELECT display_name FROM users WHERE id=$1", [userId]);
      const message = { ...saved.rows[0], sender_name: u.rows[0].display_name };
      io.to(`group:${groupId}`).emit("group:new", message);
      if (ack) ack({ ok: true });
    } catch (e) { if (ack) ack({ ok: false, error: e.message }); }
  });

  socket.on("group:join-room", async (groupId) => {
    const id = Number(groupId);
    const member = await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2", [id, userId]);
    if (member.rowCount) socket.join(`group:${id}`);
  });

  socket.on("disconnect", () => {
    const count = (onlineUsers.get(userId) || 1) - 1;
    if (count <= 0) {
      onlineUsers.delete(userId);
      io.emit("presence", { userId, online: false });
    } else onlineUsers.set(userId, count);
  });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

setupDatabase().then(() => {
  server.listen(PORT, () => console.log(`Scroll Chat is running on ${PORT}`));
}).catch(err => {
  console.error("Database setup failed:", err);
  process.exit(1);
});
