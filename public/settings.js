const modelInput = document.getElementById("modelInput");
const temperatureInput = document.getElementById("temperatureInput");
const portInput = document.getElementById("portInput");
const apiKeyStatus = document.getElementById("apiKeyStatus");
const saveBtn = document.getElementById("saveSettingsBtn");
const msg = document.getElementById("settingsMessage");

function showMessage(text, isError = false) {
  msg.textContent = text;
  msg.className = "settings-message" + (isError ? " is-error" : "");
}

async function loadSettings() {
  showMessage("正在读取设置...");

  try {
    const res = await fetch("/api/settings");
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "读取失败");

    modelInput.value = data.model || "";
    temperatureInput.value = data.temperature ?? 1.0;
    portInput.value = data.port || 3000;
    apiKeyStatus.textContent = data.hasApiKey ? "已配置" : "未配置";
    apiKeyStatus.className = data.hasApiKey ? "ok" : "bad";

    showMessage("");
  } catch (e) {
    showMessage("读取失败：" + (e.message || e), true);
  }
}

saveBtn.addEventListener("click", async () => {
  const payload = {
    model: modelInput.value.trim(),
    temperature: Number(temperatureInput.value),
    port: Number(portInput.value)
  };

  if (!payload.model) {
    showMessage("model 不能为空。", true);
    return;
  }

  try {
    saveBtn.disabled = true;
    showMessage("正在保存...");

    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "保存失败");

    showMessage("已保存。建议重启小屋让设置完全生效。");
  } catch (e) {
    showMessage("保存失败：" + (e.message || e), true);
  } finally {
    saveBtn.disabled = false;
  }
});

loadSettings();
