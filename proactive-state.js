const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "data", "proactive-status.json");

function now() {
  return Date.now();
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {
      service: "unknown",
      backend: "online",
      lastCheckAt: null,
      lastSuccessAt: null,
      lastNotifyAt: null,
      lastResult: null,
      lastReason: null,
      lastText: null,
      lastError: null,
      nextAt: null,
      countToday: 0,
      updatedAt: now()
    };
  }
}

function writeState(patch) {
  const old = readState();
  const next = {
    ...old,
    ...patch,
    backend: "online",
    updatedAt: now()
  };
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

function markCheck() {
  return writeState({
    lastCheckAt: now(),
    lastError: null
  });
}

function markResult(body) {
  const ok = !!body?.ok;
  const text = body?.text || null;
  const reason = body?.reason || null;
  const nextAt = body?.nextAt || null;

  const patch = {
    lastResult: ok ? "success" : "waiting",
    lastReason: reason,
    nextAt,
    lastError: null
  };

  if (ok) {
    patch.lastSuccessAt = now();
    patch.lastNotifyAt = now();
    patch.lastText = text;
    patch.countToday = (readState().countToday || 0) + 1;
  }

  return writeState(patch);
}

function markError(err) {
  return writeState({
    lastResult: "error",
    lastError: String(err && err.stack ? err.stack : err),
  });
}

module.exports = {
  readState,
  writeState,
  markCheck,
  markResult,
  markError
};
