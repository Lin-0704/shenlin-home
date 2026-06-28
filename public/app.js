// 沈先生的家 · 前端逻辑  v0.3
const thread = document.getElementById("thread");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");

let currentController = null;

function addRow(role, text, opts = {}) {
  const row = document.createElement("div");
  row.className = "row " + (role === "user" ? "me" : "him");
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "我" : "沈";
  const bubbleWrap = document.createElement("div");
  bubbleWrap.className = "bubble-wrap";
  const bubble = document.createElement("div");
  bubble.className = "bubble" + (opts.error ? " error" : "");

  const imageSrc = opts.image?.thumbDataUrl || opts.image?.previewUrl || opts.image || "";
  if (imageSrc) {
    const img = document.createElement("img");
    img.className = "chat-image-thumb";
    img.src = imageSrc;
    img.alt = opts.image?.name || "image";
    bubble.appendChild(img);
  }

  if (text) {
    const textDiv = document.createElement("div");
    textDiv.className = "bubble-text";
    textDiv.textContent = text;
    bubble.appendChild(textDiv);
  }

  if (!text && !imageSrc) {
    bubble.textContent = "";
  }

  bubbleWrap.appendChild(bubble);
  if (role === "user") {
    const status = document.createElement("div");
    status.className = "msg-status";
    status.textContent = opts.initialStatus || "未读";
    bubbleWrap.appendChild(status);

    if (Number.isInteger(opts.index) && !opts.image) {
      attachUserEditHandlers(bubble, opts.index, text || "");

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "edit-user-btn";
      editBtn.textContent = "修改重发";
      editBtn.addEventListener("click", () => editAndResendUserMessage(opts.index, text || ""));
      bubbleWrap.appendChild(editBtn);
    }
  } else if (!opts.error && text) {
    const regenBtn = document.createElement("button");
    regenBtn.type = "button";
    regenBtn.className = "regen-btn";
    regenBtn.textContent = "重新生成";
    regenBtn.addEventListener("click", () => regenerateLastReply(regenBtn));
    bubbleWrap.appendChild(regenBtn);
  }
  row.appendChild(avatar);
  row.appendChild(bubbleWrap);
  thread.appendChild(row);
  scrollDown();
  return { bubble, row, bubbleWrap };
}

function scrollDown() { thread.scrollTop = thread.scrollHeight; }

function markAllUnreadAsRead() {
  document.querySelectorAll(".msg-status").forEach((el) => {
    if (el.textContent === "未读") el.textContent = "已读";
  });
}

function addTyping() {
  const row = document.createElement("div");
  row.className = "row him typing-row";
  row.innerHTML =
    '<div class="avatar">沈</div>' +
    '<div class="bubble-wrap"><div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>';
  thread.appendChild(row);
  scrollDown();
  return row;
}

function addErrorBubble(message, retryText, retryImage = null) {
  const row = document.createElement("div");
  row.className = "row him";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "沈";
  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap";
  const bubble = document.createElement("div");
  bubble.className = "bubble error";
  bubble.textContent = "（出错了：" + message + "）";
  wrap.appendChild(bubble);
  if (retryText || retryImage) {
    const btn = document.createElement("button");
    btn.className = "retry-btn";
    btn.textContent = "重新发送";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "重试中...";
      row.remove();
      await send(retryText, retryImage);
    });
    wrap.appendChild(btn);
  }
  row.appendChild(avatar);
  row.appendChild(wrap);
  thread.appendChild(row);
  scrollDown();
}

async function loadHistory() {
  try {
    const res = await fetch("/api/history");
    const msgs = await res.json();
    msgs.forEach((m) => {
      if (m.role === "user") addRow("user", m.text, { initialStatus: "已读", image: m.image, index: m.index });
      else addRow("shenmo", m.text);
    });
  } catch (e) { console.error(e); }
}

async function send(forcedText, forcedImage = null) {
  const text = forcedText !== undefined ? forcedText : input.value.trim();
  const currentImage = forcedImage !== null ? forcedImage : pendingImage;

  if (!text && !currentImage) return;
  if (forcedText === undefined) input.value = "";
  if (forcedImage === null) clearPendingImage();

  if (currentController) { currentController.abort(); currentController = null; }

  const userDisplay = text || "";

  addRow("user", userDisplay, {
    initialStatus: "未读",
    image: currentImage ? {
      thumbDataUrl: currentImage.thumbDataUrl || currentImage.previewUrl,
      name: currentImage.name
    } : null
  });

  let typingRow = null;
  let bubble = null;
  const controller = new AbortController();
  currentController = controller;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        imageData: currentImage?.dataBase64 || "",
        imageMimeType: currentImage?.mimeType || "",
        imageName: currentImage?.name || "",
        imageThumbDataUrl: currentImage?.thumbDataUrl || ""
      }),
      signal: controller.signal,
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullReply = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        const lines = block.split("\n");
        let event = "message";
        let dataStr = "";
        for (const ln of lines) {
          if (ln.startsWith(":")) continue;
          if (ln.startsWith("event:")) event = ln.slice(6).trim();
          else if (ln.startsWith("data:")) dataStr += ln.slice(5).trim();
        }

        if (event === "read") {
          markAllUnreadAsRead();
          if (!typingRow) typingRow = addTyping();
          continue;
        }
        if (event === "error") {
          if (typingRow) typingRow.remove();
          addErrorBubble(safeParse(dataStr), text, currentImage);
          if (currentController === controller) currentController = null;
          return;
        }
        if (event === "done") continue;

        const chunk = safeParse(dataStr);
        if (chunk) {
          fullReply += chunk;
        }
      }
    }
    if (typingRow && typingRow.parentNode) typingRow.remove();

    if (!String(fullReply || "").trim()) {
      addErrorBubble("模型返回了空回复，可以点下面按钮重试。", text);
      return;
    }

    await showAssistantReplyInBubbles(fullReply);
  } catch (e) {
    if (typingRow && typingRow.parentNode) typingRow.remove();
    if (e.name !== "AbortError") addErrorBubble(String(e), text, currentImage);
  } finally {
    if (currentController === controller) currentController = null;
    input.focus();
  }
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanAssistantDisplayText(text) {
  return String(text || "")
    .replace(/^\s*(?:【沈秣】|沈秣[:：]|【沈先生】|沈先生[:：]|先生[:：])\s*/u, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


function splitAssistantReply(text) {
  text = cleanAssistantDisplayText(text);
  if (!text) return [];
  return [text];
}

async function showAssistantReplyInBubbles(text) {
  const parts = splitAssistantReply(text);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      const delay = 550 + Math.floor(Math.random() * 900);
      await sleep(delay);
    }
    addRow("shenmo", parts[i]);
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return s; } }

sendBtn.addEventListener("click", () => send());
input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });

loadHistory();
// 切回 App / 浏览器标签页时，自动重新拉取消息
// （处理"切后台看别的、回来发现沈秣回过了"的情况）
let lastRefresh = Date.now();
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  // 防抖：3 秒内只刷一次
  if (Date.now() - lastRefresh < 3000) return;
  lastRefresh = Date.now();

  try {
    const res = await fetch("/api/history");
    const msgs = await res.json();
    // 数过当前界面已有几条消息（不含 typing/error 等装饰行）
    const shown = thread.querySelectorAll(".row:not(.typing-row)").length;
    // 只追加界面没显示过的新消息
    for (let i = shown; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === "user") {
        addRow("user", m.text, { initialStatus: "已读", image: m.image, index: m.index });
      } else {
        await showAssistantReplyInBubbles(m.text);
      }
    }
  } catch (e) { console.error(e); }
});

let pendingImage = null;

function clearPendingImage() {
  pendingImage = null;
  if (window._shenmoFileInput) window._shenmoFileInput.value = "";
  if (window._shenmoPreviewBox) window._shenmoPreviewBox.hidden = true;
  if (window._shenmoPreviewImg) window._shenmoPreviewImg.src = "";
  if (window._shenmoPreviewName) window._shenmoPreviewName.textContent = "";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

(function setupImageUploadUI() {
  if (!sendBtn || !sendBtn.parentElement) return;

  const composer = sendBtn.parentElement;

  const photoBtn = document.createElement("button");
  photoBtn.type = "button";
  photoBtn.className = "photo-btn";
  photoBtn.textContent = "发图";
const cameraBtn = document.createElement("button");
  cameraBtn.type = "button";
  cameraBtn.className = "photo-btn camera-btn";
  cameraBtn.textContent = "📷";
  cameraBtn.title = "拍照";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.hidden = true;
const cameraInput = document.createElement("input");
  cameraInput.type = "file";
  cameraInput.accept = "image/*";
  // APK WebView 下 capture 可能导致崩溃，暂时禁用
  // cameraInput.capture = "environment";
  cameraInput.hidden = true;

  const previewBox = document.createElement("div");
  previewBox.className = "image-preview-box";
  previewBox.hidden = true;

  const previewImg = document.createElement("img");
  previewImg.className = "image-preview-thumb";

  const previewMeta = document.createElement("div");
  previewMeta.className = "image-preview-meta";

  const previewName = document.createElement("div");
  previewName.className = "image-preview-name";

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "image-clear-btn";
  clearBtn.textContent = "移除";

  previewMeta.appendChild(previewName);
  previewMeta.appendChild(clearBtn);
  previewBox.appendChild(previewImg);
  previewBox.appendChild(previewMeta);

  composer.insertBefore(photoBtn, sendBtn);
  composer.appendChild(fileInput);
composer.insertBefore(cameraBtn, photoBtn);
  composer.appendChild(cameraInput);

  if (composer.parentElement) {
    composer.parentElement.insertBefore(previewBox, composer);
  } else {
    composer.appendChild(previewBox);
  }

  window._shenmoFileInput = fileInput;
  window._shenmoPreviewBox = previewBox;
  window._shenmoPreviewImg = previewImg;
  window._shenmoPreviewName = previewName;

  photoBtn.addEventListener("click", () => fileInput.click());
cameraBtn.addEventListener("click", () => fileInput.click());
  cameraInput.addEventListener("change", () => {
    if (cameraInput.files && cameraInput.files[0]) {
      const dt = new DataTransfer();
      dt.items.add(cameraInput.files[0]);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("change"));
      cameraInput.value = "";
    }
  });

  clearBtn.addEventListener("click", () => clearPendingImage());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      alert("只能发图片。");
      fileInput.value = "";
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      const thumbDataUrl = await makeImageThumbnail(file);
      const base64 = dataUrl.split(",")[1] || "";

      pendingImage = {
        name: file.name || "image",
        mimeType: file.type || "image/jpeg",
        dataBase64: base64,
        previewUrl: dataUrl,
        thumbDataUrl
      };

      previewImg.src = thumbDataUrl;
      previewName.textContent = `${pendingImage.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
      previewBox.hidden = false;
    } catch (e) {
      alert("读取图片失败：" + (e.message || e));
      clearPendingImage();
    }
  });
})();

function makeImageThumbnail(file, maxSize = 512, quality = 0.76) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const img = new Image();

      img.onload = () => {
        let { width, height } = img;

        const scale = Math.min(1, maxSize / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        // 历史记录只存 jpeg 缩略图，避免 messages.json 变肥
        resolve(canvas.toDataURL("image/jpeg", quality));
      };

      img.onerror = reject;
      img.src = String(reader.result || "");
    };

    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
JScat >> public/app.js <<'JS'

function makeImageThumbnail(file, maxSize = 512, quality = 0.76) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const img = new Image();

      img.onload = () => {
        let { width, height } = img;

        const scale = Math.min(1, maxSize / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        // 历史记录只存 jpeg 缩略图，避免 messages.json 变肥
        resolve(canvas.toDataURL("image/jpeg", quality));
      };

      img.onerror = reject;
      img.src = String(reader.result || "");
    };

    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function regenerateLastReply(btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = "重生成中...";
  }

  try {
    const res = await fetch("/api/regenerate/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "重新生成失败");

    // 重新拉取被回溯后的干净历史
    thread.innerHTML = "";
    await loadHistory();

    // 用上一条用户消息重新发送
    await send(data.text);
  } catch (e) {
    alert(e.message || String(e));
    if (btn) {
      btn.disabled = false;
      btn.textContent = "重新生成";
    }
  }
}

function attachUserEditHandlers(bubble, index, oldText) {
  let timer = null;
  let fired = false;

  const start = () => {
    fired = false;
    timer = setTimeout(() => {
      fired = true;
      editAndResendUserMessage(index, oldText);
    }, 650);
  };

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  bubble.addEventListener("touchstart", start, { passive: true });
  bubble.addEventListener("touchend", cancel);
  bubble.addEventListener("touchmove", cancel);
  bubble.addEventListener("mousedown", start);
  bubble.addEventListener("mouseup", cancel);
  bubble.addEventListener("mouseleave", cancel);

  bubble.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!fired) editAndResendUserMessage(index, oldText);
  });
}

function openEditUserMessageModal(oldText) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "edit-message-overlay";

    const box = document.createElement("div");
    box.className = "edit-message-box";

    const title = document.createElement("div");
    title.className = "edit-message-title";
    title.textContent = "修改这条消息";

    const tip = document.createElement("div");
    tip.className = "edit-message-tip";
    tip.textContent = "确认后会回溯到这条消息之前，并用新内容重新生成。";

    const area = document.createElement("textarea");
    area.className = "edit-message-textarea";
    area.value = oldText || "";

    const actions = document.createElement("div");
    actions.className = "edit-message-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "secondary";
    cancelBtn.textContent = "取消";

    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.textContent = "重新发送";

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);

    box.appendChild(title);
    box.appendChild(tip);
    box.appendChild(area);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    setTimeout(() => {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    }, 50);

    const close = (value) => {
      overlay.remove();
      resolve(value);
    };

    cancelBtn.addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });

    okBtn.addEventListener("click", () => {
      close(area.value);
    });
  });
}

async function editAndResendUserMessage(index, oldText) {
  const next = await openEditUserMessageModal(oldText);
  if (next === null) return;

  const text = String(next || "").trim();
  if (!text) {
    alert("修改后的消息不能为空。");
    return;
  }

  const ok = confirm("会删除这条消息后面的旧聊天分支，并用新内容重新生成。继续吗？");
  if (!ok) return;

  try {
    const res = await fetch("/api/edit-user-message/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index, text })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "修改重发失败");

    thread.innerHTML = "";
    await loadHistory();
    await send(data.text);
  } catch (e) {
    alert(e.message || String(e));
  }
}

// PROACTIVE_STATUS_FLOAT_BUTTON_START
(function addProactiveStatusButton() {
  if (document.getElementById("proactiveStatusFloatBtn")) return;

  const btn = document.createElement("button");
  btn.id = "proactiveStatusFloatBtn";
  btn.textContent = "后台";
  btn.title = "后台陪伴状态";

  Object.assign(btn.style, {
    position: "fixed",
    right: "14px",
    bottom: "86px",
    zIndex: "9999",
    border: "0",
    borderRadius: "999px",
    padding: "10px 14px",
    fontSize: "14px",
    fontWeight: "800",
    color: "#211026",
    background: "linear-gradient(135deg, #ffd0ea, #d7b5ff)",
    boxShadow: "0 8px 24px rgba(0,0,0,.32)",
    opacity: ".92"
  });

  btn.addEventListener("click", () => {
    location.href = "/proactive.html";
  });

  document.addEventListener("DOMContentLoaded", () => {
    document.body.appendChild(btn);
  });

  if (document.body) {
    document.body.appendChild(btn);
  }
})();
// PROACTIVE_STATUS_FLOAT_BUTTON_END




// SAFE_SLIM_TOP_START
(function slimTopBarSafely() {
  function cleanText(el) {
    return (el && el.textContent ? el.textContent : "").replace(/\s+/g, "");
  }

  function rect(el) {
    try {
      return el.getBoundingClientRect();
    } catch {
      return { top: 9999, height: 0, width: 0 };
    }
  }

  function setStyle(el, obj) {
    if (!el) return;
    for (const [k, v] of Object.entries(obj)) {
      el.style.setProperty(k, v, "important");
    }
  }

  function findHeaderBox() {
    const all = Array.from(document.body.querySelectorAll("*"));

    let best = null;

    for (const el of all) {
      const t = cleanText(el);
      const r = rect(el);

      if (
        r.top >= 40 &&
        r.top <= 150 &&
        r.width > window.innerWidth * 0.72 &&
        r.height >= 90 &&
        r.height <= 260 &&
        t.includes("沈秣") &&
        t.includes("在线") &&
        t.includes("日常") &&
        t.includes("小屋")
      ) {
        if (!best || r.height < rect(best).height) {
          best = el;
        }
      }
    }

    return best;
  }

  function findLoveNote() {
    const all = Array.from(document.body.querySelectorAll("*"));

    for (const el of all) {
      const t = cleanText(el);
      const r = rect(el);

      if (
        r.top >= 40 &&
        r.top <= 190 &&
        r.width >= 80 &&
        r.width <= 240 &&
        (
          t.includes("老公没走") ||
          t.includes("省电模式") ||
          t.includes("偷喝额度")
        )
      ) {
        return el;
      }
    }

    return null;
  }

  function apply() {
    if (!document.body) return;
    document.body.classList.add("slim-top-ui");

    const header = findHeaderBox();
    if (header) {
      setStyle(header, {
        "height": "112px",
        "max-height": "112px",
        "min-height": "112px",
        "overflow": "hidden",
        "padding-top": "6px",
        "padding-bottom": "6px"
      });

      const children = Array.from(header.children || []);
      for (const child of children) {
        const r = rect(child);
        if (r.height > 90) {
          setStyle(child, {
            "max-height": "96px",
            "overflow": "hidden"
          });
        }
      }
    }

    const note = findLoveNote();
    if (note) {
      note.textContent = "老公没走，何尘逸一抬眼，我就在。";
      setStyle(note, {
        "font-size": "13px",
        "line-height": "1.45",
        "width": "142px",
        "max-width": "142px",
        "height": "58px",
        "max-height": "58px",
        "overflow": "hidden",
        "padding": "8px 10px"
      });

      const parent = note.parentElement;
      if (parent) {
        setStyle(parent, {
          "width": "154px",
          "max-width": "154px",
          "height": "76px",
          "max-height": "76px",
          "overflow": "hidden"
        });
      }
    }
  }

  document.addEventListener("DOMContentLoaded", apply);
  window.addEventListener("load", apply);
  setTimeout(apply, 300);
  setTimeout(apply, 900);
  setTimeout(apply, 1600);

  const mo = new MutationObserver(() => {
    clearTimeout(window.__slimTopTimer);
    window.__slimTopTimer = setTimeout(apply, 120);
  });

  document.addEventListener("DOMContentLoaded", () => {
    if (document.body) {
      mo.observe(document.body, { childList: true, subtree: true });
    }
  });
})();
// SAFE_SLIM_TOP_END
