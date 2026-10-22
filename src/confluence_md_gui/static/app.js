const $ = (id) => document.getElementById(id);
const val = (id) => $(id).value.trim();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (name, cls = "") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const STEPS = ["connect", "export", "links", "preview", "github"];
const MODE_LABELS = { pages: "Một trang", "pages-with-descendants": "Trang + trang con", folders: "Folder", spaces: "Cả space" };

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML = icon(kind === "ok" ? "check" : kind === "err" ? "alert" : "info") + `<div>${message}</div>`;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "err" ? 7000 : 4000);
}

function statusBox(id, kind, html) {
  const box = $(id);
  box.className = "status-box " + kind;
  box.innerHTML = icon(kind === "ok" ? "check" : kind === "warn" ? "alert" : "x") + `<p>${html}</p>`;
  box.hidden = false;
}

function busy(btn, on) {
  btn.disabled = on;
  btn.classList.toggle("loading", on);
}

function requireFields(ids) {
  let missing = null;
  ids.forEach((id) => {
    const bad = !val(id);
    $(id).classList.toggle("invalid", bad);
    if (bad && !missing) missing = id;
  });
  if (missing) {
    $(missing).focus();
    toast("Vui lòng điền đầy đủ các ô được đánh dấu.", "err");
  }
  return !missing;
}
document.addEventListener("input", (e) => e.target.classList?.remove("invalid"));

// ---------------------------------------------------------------- steps
function goto(step) {
  if (!STEPS.includes(step)) step = "connect";
  document.querySelectorAll(".steps button").forEach((b) => b.classList.toggle("active", b.dataset.step === step));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "step-" + step));
  history.replaceState(null, "", "#" + step);
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (step === "preview") loadTree();
}
function markDone(step) {
  document.querySelector(`.steps button[data-step="${step}"]`).classList.add("done");
}
document.querySelectorAll(".steps button").forEach((b) => b.addEventListener("click", () => goto(b.dataset.step)));
document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => goto(b.dataset.goto)));

document.querySelectorAll(".toggle-secret").forEach((b) => b.addEventListener("click", () => {
  const input = $(b.dataset.target);
  input.type = input.type === "password" ? "text" : "password";
  b.textContent = input.type === "password" ? "Hiện" : "Ẩn";
}));

// ---------------------------------------------------------------- console & jobs
const consoleEl = $("console");
function setConsole(open) {
  consoleEl.classList.toggle("open", open);
  document.body.classList.toggle("console-open", open);
}
$("console-toggle").addEventListener("click", () => setConsole(!consoleEl.classList.contains("open")));
$("btn-copy-log").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("log").textContent); toast("Đã sao chép nhật ký.", "ok"); }
  catch { toast("Không sao chép được, hãy bôi đen và Ctrl+C.", "err"); }
});

function setPill(state, text) {
  $("job-pill").className = "pill " + state;
  $("job-pill-text").textContent = text;
}

let logTotal = 0, polling = null;
const jobHandlers = {};

function startPolling(kind) {
  logTotal = 0;
  $("log").textContent = "";
  setConsole(true);
  setPill("running", kind === "push" ? "Đang push lên GitHub…" : "Đang export…");
  document.querySelectorAll(".btn-cancel").forEach((b) => (b.hidden = false));
  clearInterval(polling);
  polling = setInterval(async () => {
    try {
      const job = await api("/api/job?since=" + logTotal);
      if (job.lines.length) {
        const el = $("log");
        el.textContent += job.lines.join("\n") + "\n";
        el.scrollTop = el.scrollHeight;
      }
      logTotal = job.total;
      $("console-count").textContent = logTotal ? logTotal + " dòng" : "";
      if (!job.running) {
        clearInterval(polling);
        document.querySelectorAll(".btn-cancel").forEach((b) => (b.hidden = true));
        setPill(job.ok ? "ok" : "err", job.ok ? "Hoàn tất" : "Có lỗi xảy ra");
        jobHandlers[job.kind]?.(job);
      }
    } catch (e) {
      clearInterval(polling);
      setPill("err", "Mất kết nối tới ứng dụng");
      toast("Mất kết nối tới ứng dụng. Kiểm tra cửa sổ terminal còn chạy không.", "err");
    }
  }, 700);
}

document.querySelectorAll(".btn-cancel").forEach((b) => b.addEventListener("click", () => api("/api/cancel", {})));

// ---------------------------------------------------------------- 1. connect
const creds = () => ({ base_url: val("base_url"), email: val("email"), token: val("token") });

$("btn-connect").addEventListener("click", async () => {
  if (!requireFields(["base_url", "email", "token"])) return;
  const btn = $("btn-connect");
  busy(btn, true);
  try {
    const r = await api("/api/confluence-check", creds());
    statusBox("connect-status", "ok", `Đã kết nối với tài khoản <b>${esc(r.name)}</b>.`);
    markDone("connect");
    toast("Kết nối Confluence thành công.", "ok");
  } catch (e) {
    statusBox("connect-status", "err", esc(e.message));
  } finally { busy(btn, false); }
});

// ---------------------------------------------------------------- 2. export
let mode = "pages-with-descendants", modeTouched = false;
function setMode(value, touched = false) {
  mode = value;
  if (touched) modeTouched = true;
  document.querySelectorAll("#mode button").forEach((b) => {
    b.classList.toggle("selected", b.dataset.value === value);
    b.setAttribute("aria-checked", b.dataset.value === value);
  });
}
document.querySelectorAll("#mode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.value, true)));

$("target_url").addEventListener("input", () => {
  const hint = $("detect-hint");
  let url;
  try { url = new URL(val("target_url")); } catch { hint.textContent = "Mở trang trên trình duyệt, sao chép địa chỉ trên thanh URL và dán vào đây."; return; }
  const path = decodeURIComponent(url.pathname);
  let kind = null, name = "";
  if (/\/folder\/\d+/.test(path)) kind = "folders";
  else if (/\/pages\/\d+/.test(path)) { kind = "page"; name = (path.split("/").pop() || "").replace(/\+/g, " "); }
  else if (/\/spaces\/[^/]+\/?(overview)?\/?$/.test(path)) { kind = "spaces"; name = path.match(/\/spaces\/([^/]+)/)[1]; }
  if (!modeTouched && kind) setMode(kind === "page" ? (mode === "pages" ? "pages" : "pages-with-descendants") : kind);
  if (!val("base_url")) $("base_url").value = url.origin;
  const label = kind === "page" ? `trang <b>${esc(name || "Confluence")}</b>` : kind === "spaces" ? `space <b>${esc(name)}</b>`
    : kind === "folders" ? "một <b>folder</b>" : null;
  hint.innerHTML = label ? `${icon("check")} Đã nhận diện ${label}.` : "Không nhận diện được loại đường dẫn — hãy chọn phạm vi bên dưới.";
  if (val("base_url") && url.origin !== new URL(val("base_url"), location.href).origin) {
    hint.innerHTML += ` <span style="color:var(--warn)">Đường dẫn khác địa chỉ Confluence ở bước 1.</span>`;
  }
});

$("btn-export").addEventListener("click", async () => {
  if (!val("base_url") || !val("email") || !val("token")) {
    toast("Hãy nhập thông tin kết nối Confluence trước.", "err");
    goto("connect");
    requireFields(["base_url", "email", "token"]);
    return;
  }
  if (!requireFields(["target_url", "output"])) return;
  const btn = $("btn-export");
  busy(btn, true);
  $("export-result").hidden = true;
  $("export-error").hidden = true;
  try {
    await api("/api/export", { ...creds(), mode, target_url: val("target_url"), output: val("output") });
    startPolling("export");
  } catch (e) {
    busy(btn, false);
    toast(esc(e.message), "err");
  }
});

jobHandlers.export = async (job) => {
  busy($("btn-export"), false);
  if (!job.ok) {
    const reason = [...$("log").textContent.split("\n")].reverse().find((l) => l.startsWith("Error:"));
    const friendly = /credentials/i.test(reason || "") ? "Không đăng nhập được Confluence. Kiểm tra lại địa chỉ, email và API token ở bước 1."
      : /not found|404/i.test(reason || "") ? "Không tìm thấy trang hoặc bạn không có quyền xem trang này."
      : reason ? esc(reason.replace(/^Error:\s*/, "")) : "Export bị dừng hoặc gặp lỗi.";
    statusBox("export-error", "err", `${friendly}<br><small>Chi tiết kỹ thuật nằm trong Nhật ký hoạt động bên dưới.</small>`);
    toast("Export không thành công.", "err");
    return;
  }
  $("export-error").hidden = true;
  markDone("export");
  toast("Export hoàn tất.", "ok");
  try {
    const s = await api("/api/stats?output=" + encodeURIComponent(val("output")));
    $("export-result-path").textContent = val("output");
    $("export-stats").innerHTML = statCards([
      [s.pages, "trang Markdown"], [s.images, "hình ảnh"], [s.other, "file đính kèm khác"], [formatBytes(s.bytes), "tổng dung lượng"],
    ]);
    $("export-result").hidden = false;
  } catch { /* thống kê chỉ để tham khảo */ }
};

function statCards(items) {
  return items.map(([n, label, cls = ""]) => `<div class="stat ${cls}"><div class="num">${n}</div><div class="lbl">${label}</div></div>`).join("");
}
function formatBytes(b) {
  if (b < 1024) return b + " B";
  const u = ["KB", "MB", "GB"]; let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return b.toFixed(b < 10 ? 1 : 0) + " " + u[i];
}

// ---------------------------------------------------------------- 3. links
$("btn-links").addEventListener("click", async () => {
  if (!requireFields(["output"])) { goto("export"); return; }
  const btn = $("btn-links");
  busy(btn, true);
  try {
    const r = await api("/api/check-links", { output: val("output"), strip_query: $("strip_query").checked });
    const broken = r.remote.length + r.missing.length;
    const queryLeft = $("strip_query").checked ? 0 : r.query.length;
    const group = (kind, title, why, items, fmt) => items.length ? `
      <details class="issue ${kind}">
        <summary>${icon(kind === "err" ? "x" : "alert")}${title}<span class="count">${items.length}</span>${icon("chevron", "chev")}</summary>
        <p class="why">${why}</p>
        <ul>${items.slice(0, 500).map((i) => `<li>${fmt(i)}</li>`).join("")}</ul>
      </details>` : "";
    const item = (i) => `${esc(i.src)}<br><code>${esc(i.file)}</code>`;
    let banner;
    if (!r.files) banner = statusBoxHtml("warn", "Chưa có file Markdown nào trong thư mục kết quả. Hãy export ở bước 2 trước.");
    else if (broken || r.too_big.length) banner = statusBoxHtml("warn", `Có <b>${broken + r.too_big.length}</b> mục cần xử lý trước khi đưa lên GitHub.`);
    else banner = statusBoxHtml("ok", "Mọi hình ảnh đều hợp lệ và sẽ hiển thị trên GitHub.");
    $("links-report").innerHTML = `
      <div class="stats">${statCards([
        [r.files, "file Markdown"], [r.images, "liên kết ảnh"],
        [broken, "ảnh sẽ bị lỗi", broken ? "err" : "ok"],
        [r.fixed, "file đã tự sửa", r.fixed ? "ok" : ""],
      ])}</div>
      ${banner}
      <div class="issues">
        ${group("err", "Ảnh trỏ về Confluence hoặc web ngoài", "GitHub không đăng nhập được Confluence nên các ảnh này sẽ không hiện. Hãy tải ảnh lên Confluence dưới dạng tệp đính kèm của trang rồi export lại.", r.remote, item)}
        ${group("err", "Không tìm thấy file ảnh", "Link trỏ tới file không có trong thư mục kết quả. Thử export lại trang chứa ảnh.", r.missing, item)}
        ${group("warn", queryLeft ? "Link ảnh có tham số ?query" : "Link ảnh có tham số ?query (đã tự sửa)", "Phần ?width=… ở cuối link có thể làm GitHub không tìm thấy ảnh.", r.query, item)}
        ${group("warn", "File lớn hơn 40MB", "Quá lớn để tải lên GitHub. Khi push, file sẽ được bỏ qua và link trong tài liệu được thay bằng ghi chú dẫn về trang Confluence gốc.", r.too_big, (f) => esc(f))}
      </div>`;
    if (r.files) markDone("links");
  } catch (e) {
    $("links-report").innerHTML = statusBoxHtml("err", esc(e.message));
  } finally { busy(btn, false); }
});
function statusBoxHtml(kind, html) {
  return `<div class="status-box ${kind}">${icon(kind === "ok" ? "check" : kind === "warn" ? "alert" : "x")}<p>${html}</p></div>`;
}

// ---------------------------------------------------------------- 4. preview
let files = [];
async function loadTree() {
  if (!val("output")) return;
  try {
    files = (await api("/api/tree?output=" + encodeURIComponent(val("output")))).files;
    renderTree();
  } catch (e) { $("file-list").innerHTML = `<li>${esc(e.message)}</li>`; }
}
function renderTree() {
  const f = $("filter").value.toLowerCase();
  const shown = files.filter((p) => p.toLowerCase().includes(f));
  $("file-count").textContent = files.length ? `${shown.length} / ${files.length} file` : "";
  $("file-list").innerHTML = shown.length ? shown.map((p) => {
    const i = p.lastIndexOf("/");
    const name = p.slice(i + 1).replace(/\.md$/, ""), dir = i > 0 ? p.slice(0, i) : "";
    return `<li data-path="${esc(p)}">${icon("file")}<span class="path"><span>${esc(name)}</span>${dir ? `<small>${esc(dir)}</small>` : ""}</span></li>`;
  }).join("") : `<li class="hint">${files.length ? "Không có file khớp." : "Chưa có file Markdown nào."}</li>`;
}
$("filter").addEventListener("input", renderTree);
$("btn-refresh").addEventListener("click", loadTree);
$("file-list").addEventListener("click", async (ev) => {
  const li = ev.target.closest("li[data-path]");
  if (!li) return;
  document.querySelectorAll("#file-list li").forEach((x) => x.classList.toggle("active", x === li));
  try {
    const q = new URLSearchParams({ output: val("output"), path: li.dataset.path });
    $("preview-body").innerHTML = (await api("/api/preview?" + q)).html;
    $("preview-body").scrollTop = 0;
    markDone("preview");
  } catch (e) { $("preview-body").innerHTML = statusBoxHtml("err", esc(e.message)); }
});

// ---------------------------------------------------------------- 5. github
let ghStatus = null, repos = [], selectedRepo = null;

function renderAccount() {
  const s = ghStatus;
  $("gh-logged-out").hidden = s.logged_in;
  $("gh-logged-in").hidden = !s.logged_in;
  $("gh-repo-card").classList.toggle("disabled", !s.logged_in);
  $("gh-device-box").hidden = !s.device_enabled;
  $("gh-token-box").open = !s.device_enabled;
  $("remember-line").hidden = !s.can_remember;
  if (s.logged_in) {
    $("gh-avatar").src = s.avatar;
    $("gh-login").textContent = s.name ? `${s.name} (@${s.login})` : "@" + s.login;
    $("gh-remembered").textContent = s.remembered ? "Đã ghi nhớ đăng nhập trên máy này" : "Đăng nhập trong phiên làm việc này";
    $("new-repo-owner").textContent = s.login + " /";
  }
}

async function refreshGitHub(loadList = true) {
  ghStatus = await api("/api/gh/status");
  renderAccount();
  if (ghStatus.logged_in && loadList) await loadRepos();
  if (!ghStatus.logged_in) { repos = []; renderRepos(); }
}

async function onLoggedIn() {
  toast(`Đã đăng nhập GitHub.`, "ok");
  await refreshGitHub();
}

$("btn-gh-token").addEventListener("click", async () => {
  if (!requireFields(["gh_token"])) return;
  const btn = $("btn-gh-token");
  busy(btn, true);
  try {
    await api("/api/gh/token", { token: val("gh_token"), remember: $("gh_remember").checked });
    $("gh_token").value = "";
    await onLoggedIn();
  } catch (e) { toast(esc(e.message), "err"); }
  finally { busy(btn, false); }
});

let devicePoll = null;
$("btn-gh-login").addEventListener("click", async () => {
  const btn = $("btn-gh-login");
  busy(btn, true);
  try {
    const d = await api("/api/gh/device", { remember: $("gh_remember").checked });
    $("device-code").textContent = d.user_code;
    $("device-open").href = d.verification_uri;
    $("device-dialog").showModal();
    window.open(d.verification_uri, "_blank", "noopener");
    clearInterval(devicePoll);
    devicePoll = setInterval(async () => {
      const r = await api("/api/gh/device").catch(() => ({ state: "pending" }));
      if (r.state === "pending") return;
      clearInterval(devicePoll);
      $("device-dialog").close();
      if (r.state === "ok") await onLoggedIn();
      else toast(esc(r.message || "Đăng nhập không thành công."), "err");
    }, 2000);
  } catch (e) { toast(esc(e.message), "err"); }
  finally { busy(btn, false); }
});
$("device-cancel").addEventListener("click", () => { clearInterval(devicePoll); $("device-dialog").close(); });
$("btn-copy-code").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("device-code").textContent); toast("Đã sao chép mã.", "ok"); } catch { /* người dùng tự chọn mã */ }
});

$("btn-gh-logout").addEventListener("click", async () => {
  ghStatus = await api("/api/gh/logout", {});
  selectedRepo = null;
  $("repo").value = "";
  renderAccount();
  repos = []; renderRepos(); updatePushTarget();
});

async function loadRepos() {
  $("repo-list").innerHTML = `<li class="hint"><span class="spinner"></span>Đang tải danh sách repo…</li>`;
  try {
    repos = (await api("/api/gh/repos")).repos;
    const saved = val("repo");
    selectedRepo = repos.find((r) => r.full_name === saved) || null;
    renderRepos();
    updatePushTarget();
  } catch (e) { $("repo-list").innerHTML = `<li class="hint">${esc(e.message)}</li>`; }
}

function renderRepos() {
  const q = $("repo-search").value.toLowerCase();
  const shown = repos.filter((r) => r.full_name.toLowerCase().includes(q));
  if (!ghStatus?.logged_in) {
    $("repo-list").innerHTML = `<li class="hint">Đăng nhập GitHub để xem danh sách repo.</li>`;
    return;
  }
  $("repo-list").innerHTML = shown.length ? shown.map((r) => `
    <li data-repo="${esc(r.full_name)}" class="${selectedRepo?.full_name === r.full_name ? "selected" : ""}">
      ${icon(selectedRepo?.full_name === r.full_name ? "check" : "folder")}
      <span class="r-name">${esc(r.full_name)}${r.description ? `<small>${esc(r.description)}</small>` : ""}</span>
      ${r.private ? `<span class="tag private">${icon("lock")}Private</span>` : `<span class="tag public">Public</span>`}
    </li>`).join("")
    : `<li class="hint">${repos.length ? "Không có repo khớp." : "Bạn chưa có repo nào có quyền ghi — hãy tạo repo mới."}</li>`;
}
$("repo-search").addEventListener("input", renderRepos);
$("btn-reload-repos").addEventListener("click", loadRepos);
$("repo-list").addEventListener("click", (ev) => {
  const li = ev.target.closest("li[data-repo]");
  if (!li) return;
  selectRepo(repos.find((r) => r.full_name === li.dataset.repo));
});
function selectRepo(r) {
  selectedRepo = r;
  $("repo").value = r.full_name;
  $("branch").value = r.default_branch;
  renderRepos();
  updatePushTarget();
}
function updatePushTarget() {
  $("push-target").innerHTML = selectedRepo
    ? `→ <b>${esc(selectedRepo.full_name)}</b> · nhánh <code>${esc(val("branch") || selectedRepo.default_branch)}</code>${val("subdir") ? ` · thư mục <code>${esc(val("subdir"))}</code>` : ""}`
    : "";
}
["branch", "subdir"].forEach((id) => $(id).addEventListener("input", updatePushTarget));

$("btn-new-repo").addEventListener("click", () => {
  $("new-repo").hidden = false;
  $("new-repo").style.setProperty("--prefix-w", $("new-repo-owner").offsetWidth + "px");
  $("new-repo-name").focus();
});
$("btn-cancel-repo").addEventListener("click", () => { $("new-repo").hidden = true; });
$("btn-create-repo").addEventListener("click", async () => {
  if (!requireFields(["new-repo-name"])) return;
  const btn = $("btn-create-repo");
  busy(btn, true);
  try {
    const r = await api("/api/gh/create-repo", { name: val("new-repo-name"), private: $("new-repo-private").checked });
    repos.unshift(r);
    $("new-repo").hidden = true;
    $("new-repo-name").value = "";
    selectRepo(r);
    toast(`Đã tạo repo <b>${esc(r.full_name)}</b>.`, "ok");
  } catch (e) { toast(esc(e.message), "err"); }
  finally { busy(btn, false); }
});

function confirmPublic() {
  return new Promise((resolve) => {
    const dlg = $("confirm-public");
    const done = (ok) => { dlg.close(); resolve(ok); };
    $("public-ok").onclick = () => done(true);
    $("public-cancel").onclick = () => done(false);
    dlg.oncancel = () => resolve(false);
    dlg.showModal();
  });
}

$("btn-push").addEventListener("click", async () => {
  if (!ghStatus?.logged_in) { toast("Hãy đăng nhập GitHub trước.", "err"); return; }
  if (!selectedRepo) { toast("Hãy chọn một repository.", "err"); $("repo-search").focus(); return; }
  if (!val("output")) { toast("Chưa có thư mục kết quả. Hãy export ở bước 2.", "err"); goto("export"); return; }
  if (!selectedRepo.private && !(await confirmPublic())) return;
  const btn = $("btn-push");
  busy(btn, true);
  $("push-result").hidden = true;
  $("push-error").hidden = true;
  try {
    await api("/api/push", {
      repo: selectedRepo.full_name, branch: val("branch"), subdir: val("subdir"),
      message: val("message"), output: val("output"), allow_public: !selectedRepo.private,
    });
    startPolling("push");
  } catch (e) {
    busy(btn, false);
    statusBox("push-error", "err", esc(e.message));
  }
});

jobHandlers.push = (job) => {
  busy($("btn-push"), false);
  if (!job.ok) {
    const reason = [...$("log").textContent.split("\n")].reverse().find((l) => l.includes("Lỗi") || l.includes("lỗi"));
    statusBox("push-error", "err", esc(reason || "Push không thành công.") + "<br><small>Chi tiết nằm trong Nhật ký hoạt động bên dưới.</small>");
    toast("Push không thành công.", "err");
    return;
  }
  markDone("github");
  const n = job.result?.files ?? 0;
  $("push-result-text").textContent = n ? `${n} file mới hoặc đã thay đổi được tải lên.` : "Không có thay đổi nào so với GitHub.";
  const skipped = job.result?.skipped || [];
  if (skipped.length) {
    $("push-result-text").textContent += ` Bỏ qua ${skipped.length} file quá lớn (>40MB) — trong tài liệu đã thay bằng ghi chú dẫn về Confluence.`;
    toast(`Đã bỏ qua ${skipped.length} file quá lớn — xem chi tiết trong nhật ký.`, "info");
  }
  $("push-result-link").href = job.result?.url || "#";
  $("push-result").hidden = false;
  toast("Đã đưa tài liệu lên GitHub.", "ok");
};

// ---------------------------------------------------------------- init
(async () => {
  setMode(mode);
  goto(location.hash.slice(1) || "connect");
  try {
    const s = await api("/api/settings");
    for (const k of ["base_url", "email", "output", "repo", "branch", "subdir"]) if (s[k]) $(k).value = s[k];
    $("version").textContent = "v" + s.version;
    refreshGitHub().catch(() => {});
    const job = await api("/api/job");
    if (job.running) {
      busy($(job.kind === "push" ? "btn-push" : "btn-export"), true);
      startPolling(job.kind);
    }
  } catch (e) { toast(esc(e.message), "err"); }
})();
