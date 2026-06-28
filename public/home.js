const statusBox = document.getElementById("homeStatus");

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function loadHomeStatus() {
  try {
    const [backupRes, settingsRes] = await Promise.all([
      fetch("/api/backup/info"),
      fetch("/api/settings")
    ]);

    const backup = await backupRes.json();
    const settings = await settingsRes.json();

    if (!backupRes.ok) throw new Error(backup.error || "备份状态读取失败");
    if (!settingsRes.ok) throw new Error(settings.error || "设置读取失败");

    statusBox.innerHTML = `
      <div>聊天记录：<strong>${escapeHtml(backup.messages)}</strong> 条</div>
      <div>长期记忆：<strong>${escapeHtml(backup.memories)}</strong> 条</div>
      <div>模型：<strong>${escapeHtml(settings.model || "未设置")}</strong></div>
      <div>API key：<strong>${settings.hasApiKey ? "已配置" : "未配置"}</strong></div>
    `;
  } catch (e) {
    statusBox.textContent = "读取失败：" + (e.message || e);
  }
}

loadHomeStatus();
