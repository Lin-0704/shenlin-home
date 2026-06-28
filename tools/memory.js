import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const db = path.join(root, "data", "memory.db");

const cmd = process.argv[2];

function sqlEscape(s) {
  return String(s ?? "").replace(/'/g, "''");
}

function run(sql, json = false) {
  const args = json ? ["-json", db, sql] : [db, sql];
  return execFileSync("sqlite3", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function help() {
  console.log(`
记忆库工具：

  node tools/memory.js list
  node tools/memory.js add <分类> <重要度0-1> <内容> [关键词逗号分隔]
  node tools/memory.js off <id>
  node tools/memory.js on <id>
  node tools/memory.js del <id>
  node tools/memory.js edit <id> <新内容>

例子：

  node tools/memory.js list
  node tools/memory.js add preference 0.95 "用户喜欢 QQ/微信私聊感。" "微信感,聊天风格"
  node tools/memory.js off 3
  node tools/memory.js edit 2 "用户不喜欢动作描写、小说旁白、客服腔。"
`);
}

if (!cmd || cmd === "help") {
  help();
  process.exit(0);
}

if (cmd === "list") {
  const rows = run(`
    SELECT id, enabled, category, importance, content
    FROM memories
    ORDER BY enabled DESC, importance DESC, updated_at DESC;
  `, true);

  const data = rows ? JSON.parse(rows) : [];
  if (!data.length) {
    console.log("记忆库空空的。");
    process.exit(0);
  }

  for (const m of data) {
    const flag = m.enabled ? "✓" : "×";
    console.log(`\\n#${m.id} ${flag} [${m.category}] importance=${m.importance}`);
    console.log(m.content);
  }
  process.exit(0);
}

if (cmd === "add") {
  const category = process.argv[3] || "general";
  const importance = Number(process.argv[4] || 0.5);
  const content = process.argv[5];
  const kw = process.argv[6] || "";

  if (!content) {
    console.error("缺少内容。用法：node tools/memory.js add <分类> <重要度0-1> <内容> [关键词逗号分隔]");
    process.exit(1);
  }

  const keywords = JSON.stringify(
    kw.split(",").map(x => x.trim()).filter(Boolean)
  );

  run(`
    INSERT INTO memories(content, category, keywords, importance, enabled, source, created_at, updated_at)
    VALUES(
      '${sqlEscape(content)}',
      '${sqlEscape(category)}',
      '${sqlEscape(keywords)}',
      ${Number.isFinite(importance) ? importance : 0.5},
      1,
      'manual-cli',
      strftime('%s','now')*1000,
      strftime('%s','now')*1000
    );
  `);

  console.log("已新增记忆。");
  process.exit(0);
}

if (cmd === "off" || cmd === "on") {
  const id = Number(process.argv[3]);
  if (!id) {
    console.error("缺少 id。");
    process.exit(1);
  }

  const enabled = cmd === "on" ? 1 : 0;
  run(`
    UPDATE memories
    SET enabled=${enabled}, updated_at=strftime('%s','now')*1000
    WHERE id=${id};
  `);

  console.log(cmd === "on" ? "已启用记忆。" : "已禁用记忆。");
  process.exit(0);
}

if (cmd === "del") {
  const id = Number(process.argv[3]);
  if (!id) {
    console.error("缺少 id。");
    process.exit(1);
  }

  run(`DELETE FROM memories WHERE id=${id};`);
  console.log("已删除记忆。");
  process.exit(0);
}

if (cmd === "edit") {
  const id = Number(process.argv[3]);
  const content = process.argv[4];

  if (!id || !content) {
    console.error("用法：node tools/memory.js edit <id> <新内容>");
    process.exit(1);
  }

  run(`
    UPDATE memories
    SET content='${sqlEscape(content)}',
        updated_at=strftime('%s','now')*1000
    WHERE id=${id};
  `);

  console.log("已修改记忆。");
  process.exit(0);
}

console.error("未知命令：", cmd);
help();
process.exit(1);
