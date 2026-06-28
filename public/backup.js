const info = document.getElementById("backupInfo");
const refreshBtn = document.getElementById("refreshBackupBtn");

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function loadBackupInfo() {
  info.textContent = "读取中...";

  try {
    const res = await fetch("/api/backup/info");
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "读取失败");

    info.innerHTML = `
      <div>聊天记录：<strong>${escapeHtml(data.messages)}</strong> 条</div>
      <div>长期记忆：<strong>${escapeHtml(data.memories)}</strong> 条</div>
      <div>memory.db：<strong>${data.hasMemoryDb ? "存在" : "不存在"}</strong></div>
      <div>persona.js：<strong>${data.hasPersona ? "存在" : "不存在"}</strong></div>
      <div>config.json：<strong>受保护，不导出</strong></div>
    `;
  } catch (e) {
    info.textContent = "读取失败：" + (e.message || e);
  }
}

refreshBtn.addEventListener("click", loadBackupInfo);
loadBackupInfo();
