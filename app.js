const $ = (id) => document.getElementById(id);
let token = localStorage.getItem("sc_token") || "";
let me = null;
let socket = null;
let authMode = "login";
let current = null;
let usersCache = [];
let groupsCache = [];
let searchTimer = null;

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}
async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "ارتباط با سرور برقرار نشد.");
  return data;
}
function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === mode));
  $("displayNameWrap").classList.toggle("hidden", mode !== "register");
  $("authSubmit").textContent = mode === "login" ? "ورود به اسکرول چت" : "ساخت حساب و ورود";
  $("authError").textContent = "";
}
document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => setAuthMode(b.dataset.tab)));
$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault(); $("authError").textContent = "";
  const payload = { username: $("username").value, password: $("password").value, displayName: $("displayName").value };
  try {
    const data = await api(`/api/${authMode}`, { method: "POST", body: JSON.stringify(payload) });
    token = data.token; me = data.user; localStorage.setItem("sc_token", token); showApp();
  } catch (err) { $("authError").textContent = err.message; }
});

async function boot() {
  if (!token) return showAuth();
  try { const data = await api("/api/me"); me = data.user; showApp(); }
  catch { logout(false); }
}
function showAuth() { $("authView").classList.remove("hidden"); $("appView").classList.add("hidden"); }
async function showApp() {
  $("authView").classList.add("hidden"); $("appView").classList.remove("hidden");
  $("myName").textContent = me.displayName; $("myUsername").textContent = "@" + me.username; $("myAvatar").textContent = me.displayName.slice(0,1);
  connectSocket(); await loadGroups(); await searchUsers("");
}
function logout(showMessage = true) {
  if (socket) socket.disconnect();
  token = ""; me = null; current = null; localStorage.removeItem("sc_token");
  $("appView").classList.add("hidden"); showAuth();
  if (showMessage) toast("از حساب خارج شدی.");
}
$("logoutBtn").addEventListener("click", () => logout());

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token } });
  socket.on("connect_error", () => toast("اتصال زنده برقرار نشد؛ صفحه را تازه کن."));
  socket.on("presence", ({userId, online}) => {
    const el = document.querySelector(`[data-user-id="${userId}"] .online-dot`);
    if (el) el.style.display = online ? "block" : "none";
    if (current?.type === "private" && Number(current.id) === Number(userId)) $("chatSubtitle").textContent = online ? "آنلاین" : "گفت‌وگوی خصوصی";
  });
  socket.on("private:new", msg => {
    if (current?.type === "private" &&
       (Number(msg.sender_id) === Number(current.id) || Number(msg.recipient_id) === Number(current.id))) {
      appendMessage(msg);
    }
  });
  socket.on("group:new", msg => {
    if (current?.type === "group" && Number(msg.group_id) === Number(current.id)) appendMessage(msg);
  });
}

$("searchInput").addEventListener("input", () => {
  clearTimeout(searchTimer); searchTimer = setTimeout(() => searchUsers($("searchInput").value), 250);
});
async function searchUsers(q) {
  if (!me) return;
  try {
    const data = await api(`/api/users?q=${encodeURIComponent(q)}`);
    usersCache = data.users; renderList();
  } catch (e) { toast(e.message); }
}
async function loadGroups() {
  const data = await api("/api/groups"); groupsCache = data.groups; renderList();
}
function renderList() {
  const list = $("chatList"); list.innerHTML = "";
  const q = $("searchInput").value.trim().toLowerCase();
  const visibleUsers = usersCache.filter(u => !q || u.username.includes(q) || u.displayName.toLowerCase().includes(q));
  if (!visibleUsers.length && !groupsCache.length) list.innerHTML = '<div class="empty-hint">چیزی پیدا نشد. نام کاربری را جست‌وجو کن.</div>';
  groupsCache.forEach(g => {
    const b = document.createElement("button"); b.className = "chat-item" + (current?.type === "group" && Number(current.id) === Number(g.id) ? " selected" : "");
    b.innerHTML = `<div class="avatar">#</div><div class="chat-item-info"><strong></strong><small>${g.members} عضو · گروه</small></div>`;
    b.querySelector("strong").textContent = g.name; b.addEventListener("click", () => openGroup(g)); list.appendChild(b);
  });
  visibleUsers.forEach(u => {
    const b = document.createElement("button"); b.className = "chat-item" + (current?.type === "private" && Number(current.id) === Number(u.id) ? " selected" : "");
    b.dataset.userId = u.id;
    b.innerHTML = `<div class="avatar">${escapeHtml(u.displayName.slice(0,1))}</div><div class="chat-item-info"><strong></strong><small>@${escapeHtml(u.username)}</small></div><span class="online-dot" style="display:none"></span>`;
    b.querySelector("strong").textContent = u.displayName; b.addEventListener("click", () => openPrivate(u)); list.appendChild(b);
  });
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

function showChat() {
  $("welcome").classList.add("hidden"); $("chatPanel").classList.remove("hidden");
  $("appView").classList.add("chat-open");
  $("messages").innerHTML = "";
}
async function openPrivate(user) {
  current = { type: "private", id: user.id, name: user.displayName };
  showChat(); $("chatTitle").textContent = user.displayName; $("chatSubtitle").textContent = "گفت‌وگوی خصوصی";
  $("chatAvatar").textContent = user.displayName.slice(0,1); $("inviteBtn").classList.add("hidden");
  renderList();
  try { const data = await api(`/api/messages/private/${user.id}`); if (current?.type === "private" && Number(current.id) === Number(user.id)) renderMessages(data.messages); }
  catch (e) { toast(e.message); }
}
async function openGroup(group) {
  current = { type: "group", id: group.id, name: group.name, inviteCode: group.invite_code };
  showChat(); $("chatTitle").textContent = group.name; $("chatSubtitle").textContent = `${group.members} عضو · گروه`;
  $("chatAvatar").textContent = "#"; $("inviteBtn").classList.remove("hidden");
  socket.emit("group:join-room", group.id); renderList();
  try { const data = await api(`/api/messages/group/${group.id}`); if (current?.type === "group" && Number(current.id) === Number(group.id)) renderMessages(data.messages); }
  catch (e) { toast(e.message); }
}
function renderMessages(messages) {
  $("messages").innerHTML = "";
  if (!messages.length) { $("messages").innerHTML = '<div class="empty-hint">هنوز پیامی وجود نداره. اولین پیام رو بفرست!</div>'; return; }
  messages.forEach(appendMessage);
}
function appendMessage(msg) {
  if ($("messages").querySelector(".empty-hint")) $("messages").innerHTML = "";
  if ($("messages").querySelector(`[data-message-id="${msg.id}"]`)) return;
  const mine = Number(msg.sender_id) === Number(me.id);
  const el = document.createElement("div"); el.className = "message" + (mine ? " mine" : ""); el.dataset.messageId = msg.id;
  const sender = document.createElement("div"); sender.className = "sender"; sender.textContent = mine ? "شما" : (msg.sender_name || "کاربر");
  el.appendChild(sender);
  if (msg.kind === "image") {
    const img = document.createElement("img"); img.src = msg.body; img.alt = "تصویر ارسال‌شده"; el.appendChild(img);
  } else {
    const body = document.createElement("div"); body.textContent = msg.body; el.appendChild(body);
  }
  const time = document.createElement("small"); time.className = "time"; time.textContent = new Date(msg.created_at).toLocaleTimeString("fa-IR", {hour:"2-digit",minute:"2-digit"}); el.appendChild(time);
  $("messages").appendChild(el); $("messages").scrollTop = $("messages").scrollHeight;
}
$("messageForm").addEventListener("submit", (e) => {
  e.preventDefault(); const body = $("messageInput").value.trim();
  if (!body || !current) return; sendMessage(body, "text"); $("messageInput").value = "";
});
function sendMessage(body, kind) {
  if (!socket || !current) return;
  const event = current.type === "private" ? "private:send" : "group:send";
  const payload = current.type === "private" ? { recipientId: current.id, body, kind } : { groupId: current.id, body, kind };
  socket.emit(event, payload, result => { if (!result?.ok) toast(result?.error || "ارسال پیام ناموفق بود."); });
}
$("imageInput").addEventListener("change", async (e) => {
  const file = e.target.files[0]; e.target.value = "";
  if (!file || !current) return;
  if (!file.type.startsWith("image/")) return toast("فقط فایل تصویری پشتیبانی می‌شود.");
  if (file.size > 3 * 1024 * 1024) return toast("حجم تصویر باید کمتر از ۳ مگابایت باشد.");
  const reader = new FileReader();
  reader.onload = () => sendMessage(reader.result, "image");
  reader.readAsDataURL(file);
});
$("backBtn").addEventListener("click", () => $("appView").classList.remove("chat-open"));
$("themeBtn").addEventListener("click", () => {
  document.body.classList.toggle("light");
  localStorage.setItem("sc_theme", document.body.classList.contains("light") ? "light" : "dark");
});
if (localStorage.getItem("sc_theme") === "light") document.body.classList.add("light");

$("newGroupBtn").addEventListener("click", () => $("groupDialog").showModal());
$("createGroupForm").addEventListener("submit", async (e) => {
  e.preventDefault(); $("groupError").textContent = "";
  try {
    const data = await api("/api/groups", { method:"POST", body:JSON.stringify({name:$("groupName").value}) });
    $("groupName").value = ""; $("groupDialog").close(); await loadGroups(); openGroup(data.group); toast("گروه ساخته شد. کد دعوت را برای دوستانت بفرست.");
  } catch (err) { $("groupError").textContent = err.message; }
});
$("joinGroupForm").addEventListener("submit", async (e) => {
  e.preventDefault(); $("groupError").textContent = "";
  try {
    await api("/api/groups/join", { method:"POST", body:JSON.stringify({code:$("inviteCodeInput").value}) });
    $("inviteCodeInput").value = ""; $("groupDialog").close(); await loadGroups(); toast("با موفقیت به گروه پیوستی.");
  } catch (err) { $("groupError").textContent = err.message; }
});
$("inviteBtn").addEventListener("click", async () => {
  if (!current?.inviteCode) return;
  try { await navigator.clipboard.writeText(current.inviteCode); toast("کد دعوت کپی شد: " + current.inviteCode); }
  catch { toast("کد دعوت گروه: " + current.inviteCode); }
});

boot();
