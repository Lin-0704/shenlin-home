// ============================================================
//  conversations.js  ·  多窗口存储模块
// ============================================================
import fs from "fs";
import path from "path";
import crypto from "crypto";

const CONVS_DIRNAME = "conversations";
const INDEX_FILE    = "_index.json";
const LEGACY_FILE   = "messages.json";
const DEFAULT_SECRET = "老公";

let DATA_DIR, CONVS_DIR, INDEX_PATH;

function makeId() { return crypto.randomBytes(6).toString("hex"); }
function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8")); }
  catch { return { active: null, conversations: [] }; }
}
function writeIndex(idx) { fs.writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2)); }
function convPath(id) { return path.join(CONVS_DIR, `${id}.json`); }
function readConv(id) {
  try { return JSON.parse(fs.readFileSync(convPath(id), "utf-8")); }
  catch { return []; }
}
function writeConv(id, msgs) { fs.writeFileSync(convPath(id), JSON.stringify(msgs, null, 2)); }

export function initConversations(dataDir = "data") {
  DATA_DIR   = path.resolve(dataDir);
  CONVS_DIR  = path.join(DATA_DIR, CONVS_DIRNAME);
  INDEX_PATH = path.join(CONVS_DIR, INDEX_FILE);
  if (!fs.existsSync(DATA_DIR))  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONVS_DIR)) fs.mkdirSync(CONVS_DIR, { recursive: true });

  let idx = readIndex();
  const legacyPath = path.join(DATA_DIR, LEGACY_FILE);
  if (idx.conversations.length === 0) {
    const dailyId = makeId();
    let legacyMsgs = [];
    if (fs.existsSync(legacyPath)) {
      try { legacyMsgs = JSON.parse(fs.readFileSync(legacyPath, "utf-8")); }
      catch { legacyMsgs = []; }
    }
    writeConv(dailyId, legacyMsgs);
    idx = {
      active: dailyId,
      conversations: [{ id: dailyId, name: "日常", hidden: false, secret: null, createdAt: Date.now() }],
    };
    writeIndex(idx);
    if (fs.existsSync(legacyPath)) {
      const bak = legacyPath + ".migrated-" + Date.now();
      fs.renameSync(legacyPath, bak);
      console.log(`  ✓ 已迁移老聊天记录到「日常」窗口（${legacyMsgs.length} 条），原文件备份为 ${path.basename(bak)}`);
    } else {
      console.log("  ✓ 已创建「日常」窗口（空）");
    }
  }
  const validIds = new Set(idx.conversations.map((c) => c.id));
  if (!validIds.has(idx.active)) {
    idx.active = idx.conversations[0]?.id || null;
    writeIndex(idx);
  }
}

export function listConversations({ includeHidden = false } = {}) {
  const idx = readIndex();
  const list = idx.conversations
    .filter((c) => includeHidden || !c.hidden)
    .map((c) => ({ id: c.id, name: c.name, hidden: !!c.hidden, createdAt: c.createdAt }));
  return { active: idx.active, conversations: list };
}

export function getActiveId() { return readIndex().active; }

export function setActiveId(id) {
  const idx = readIndex();
  if (!idx.conversations.some((c) => c.id === id)) throw new Error("窗口不存在");
  idx.active = id;
  writeIndex(idx);
  return id;
}

export function createConversation({ name = "新窗口", hidden = false, secret = null } = {}) {
  const id = makeId();
  const idx = readIndex();
  idx.conversations.push({
    id, name: String(name).slice(0, 30),
    hidden: !!hidden, secret: secret ? String(secret) : null,
    createdAt: Date.now(),
  });
  writeIndex(idx);
  writeConv(id, []);
  return id;
}

export function renameConversation(id, name) {
  const idx = readIndex();
  const c = idx.conversations.find((x) => x.id === id);
  if (!c) throw new Error("窗口不存在");
  c.name = String(name).slice(0, 30);
  writeIndex(idx);
}

export function deleteConversation(id) {
  const idx = readIndex();
  const i = idx.conversations.findIndex((x) => x.id === id);
  if (i < 0) throw new Error("窗口不存在");
  idx.conversations.splice(i, 1);
  if (idx.conversations.length === 0) {
    const newId = makeId();
    idx.conversations.push({ id: newId, name: "日常", hidden: false, secret: null, createdAt: Date.now() });
    idx.active = newId;
    writeConv(newId, []);
  } else if (idx.active === id) {
    idx.active = idx.conversations[0].id;
  }
  writeIndex(idx);
  try { fs.unlinkSync(convPath(id)); } catch {}
}

export function unlockHidden(secret) {
  const idx = readIndex();
  let target = idx.conversations.find((c) => c.hidden && c.secret === secret);
  if (target) return target.id;
  if (secret === DEFAULT_SECRET) {
    return createConversation({ name: "调教", hidden: true, secret: DEFAULT_SECRET });
  }
  return null;
}

export function updateConversationMeta(id, { name, hidden, secret, mode: req_mode } = {}) {

  const idx = readIndex();
  const c = idx.conversations.find((x) => x.id === id);
  if (!c) throw new Error("窗口不存在");
  if (name !== undefined)   c.name = String(name).slice(0, 30);
  if (hidden !== undefined) c.hidden = !!hidden;
  if (secret !== undefined) c.secret = secret ? String(secret) : null;
if (req_mode !== undefined) c.mode = String(req_mode);
  writeIndex(idx);
}
export function getConversationMode(id) {
  const idx = readIndex();
  const targetId = id || getActiveId();
  const c = idx.conversations.find((x) => x.id === targetId);
  return c?.mode || "daily";
}
export function loadMessages(id) {
  const targetId = id || getActiveId();
  if (!targetId) return [];
  return readConv(targetId);
}
export function saveMessages(msgs, id) {
  const targetId = id || getActiveId();
  if (!targetId) return;
  writeConv(targetId, msgs);
}
