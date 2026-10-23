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
  if (step === "github") loadDocs();
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
  docsLoadedFor = null;
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
let files = [], currentDoc = null;
const docLabel = (d) => d.name.replace(/\.md$/, "");

async function loadTree() {
  if (!val("output")) return;
  try {
    files = (await api("/api/docs?output=" + encodeURIComponent(val("output")))).docs;
    renderTree();
    if (currentDoc) {
      currentDoc = files.find((d) => d.path === currentDoc.path) || null;
      currentDoc ? updatePreviewToolbar() : clearPreview();
    }
  } catch (e) { $("file-list").innerHTML = `<li>${esc(e.message)}</li>`; }
}
function renderTree() {
  const f = $("filter").value.toLowerCase();
  const shown = files.filter((d) => (d.path + " " + d.name).toLowerCase().includes(f));
  $("file-count").textContent = files.length ? `${shown.length} / ${files.length} tài liệu` : "";
  $("file-list").innerHTML = shown.length ? shown.map((d) => {
    const i = d.path.lastIndexOf("/"), dir = i > 0 ? d.path.slice(0, i) : "";
    return `<li data-path="${esc(d.path)}" class="${currentDoc?.path === d.path ? "active" : ""}">${icon("file")}<span class="path">
      <span>${esc(docLabel(d))}${d.renamed ? '<span class="renamed-tag">đổi tên</span>' : ""}</span>${dir ? `<small>${esc(dir)}</small>` : ""}</span></li>`;
  }).join("") : `<li class="hint">${files.length ? "Không có tài liệu khớp." : "Chưa có tài liệu nào."}</li>`;
}
function clearPreview() {
  currentDoc = null;
  $("preview-toolbar").hidden = true;
  $("preview-body").innerHTML = `<div class="empty">${icon("file")}<p>Chọn một tài liệu bên trái để xem nội dung.</p></div>`;
}
function updatePreviewToolbar() {
  $("preview-toolbar").hidden = false;
  $("pt-title").textContent = docLabel(currentDoc);
  $("pt-sub").textContent = currentDoc.renamed ? `Tên trên máy: ${currentDoc.path.split("/").pop()}` : currentDoc.path;
}
$("filter").addEventListener("input", renderTree);
$("btn-refresh").addEventListener("click", loadTree);
$("file-list").addEventListener("click", async (ev) => {
  const li = ev.target.closest("li[data-path]");
  if (!li) return;
  currentDoc = files.find((d) => d.path === li.dataset.path);
  document.querySelectorAll("#file-list li").forEach((x) => x.classList.toggle("active", x === li));
  updatePreviewToolbar();
  try {
    const q = new URLSearchParams({ output: val("output"), path: li.dataset.path });
    $("preview-body").innerHTML = (await api("/api/preview?" + q)).html;
    $("preview-body").scrollTop = 0;
    markDone("preview");
  } catch (e) { $("preview-body").innerHTML = statusBoxHtml("err", esc(e.message)); }
});
$("pt-rename").addEventListener("click", () => currentDoc && renameDoc(currentDoc));
$("pt-delete").addEventListener("click", () => currentDoc && deleteDoc(currentDoc));

// ---- đổi tên & xoá (dùng chung cho bước 4 và 5)
async function refreshDocLists() {
  await Promise.all([loadTree(), loadDocs(true)]);
}

function renameDoc(doc) {
  const dlg = $("rename-dialog"), input = $("rename-input"), err = $("rename-error");
  const original = doc.path.split("/").pop();
  input.value = docLabel(doc);
  $("rename-original").textContent = `Tên gốc: ${original}`;
  $("rename-reset").hidden = !doc.renamed;
  err.hidden = true;
  const save = async (name) => {
    busy($("rename-ok"), true);
    try {
      await api("/api/doc/rename", { output: val("output"), path: doc.path, name });
      dlg.close();
      toast(name === original ? "Đã khôi phục tên gốc." : `Đã đổi tên thành <b>${esc(name.replace(/\.md$/, ""))}</b>.`, "ok");
      await refreshDocLists();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
    finally { busy($("rename-ok"), false); }
  };
  $("rename-form").onsubmit = (ev) => { ev.preventDefault(); save(input.value); };
  $("rename-reset").onclick = () => save(original);
  $("rename-cancel").onclick = () => dlg.close();
  dlg.showModal();
  input.select();
}

function deleteDoc(doc) {
  const dlg = $("delete-dialog");
  $("delete-name").textContent = docLabel(doc);
  $("delete-cancel").onclick = () => dlg.close();
  $("delete-ok").onclick = async () => {
    busy($("delete-ok"), true);
    try {
      const r = await api("/api/doc/delete", { output: val("output"), path: doc.path });
      dlg.close();
      picked.delete(doc.path);
      if (currentDoc?.path === doc.path) clearPreview();
      toast(`Đã xoá <b>${esc(docLabel(doc))}</b>${r.assets ? ` và ${r.assets} tệp đính kèm` : ""}.`, "ok");
      await refreshDocLists();
    } catch (e) { toast(esc(e.message), "err"); }
    finally { busy($("delete-ok"), false); }
  };
  dlg.showModal();
}

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
  if (docsLoadedFor) loadLayout().catch((e) => toast(esc(e.message), "err"));
}
function updatePushTarget() {
  if (docsLoadedFor) renderDocs();
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

// ---- sắp xếp tài liệu: cột Confluence (nguồn) → cột GitHub (cấu trúc ảo sẽ push)
let docs = [], docsLoadedFor = null, picked = new Set();
const collapsed = new Set(), tCollapsed = new Set();
// layout: folders = các thư mục ảo, docs = {khoá tài liệu → thư mục}, known = tài liệu đã từng thấy (để nhận ra tài liệu mới).
let layout = { folders: new Set(), docs: new Map(), known: new Set() }, layoutFor = null, activeFolder = "", dragging = null;
const joinPath = (...parts) => parts.filter(Boolean).join("/");
const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const layoutKey = () => val("repo");

async function loadDocs(force = false) {
  const out = val("output");
  if (!out) { $("docs-tree").innerHTML = `<div class="empty-row">Chưa có thư mục kết quả — hãy export ở bước 2.</div>`; return; }
  if (!force && docsLoadedFor === out) return;
  $("docs-tree").innerHTML = `<div class="empty-row"><span class="spinner"></span></div>`;
  try {
    docs = (await api("/api/docs?output=" + encodeURIComponent(out))).docs;
    const known = new Set(docs.map((d) => d.path));
    picked = new Set([...picked].filter((p) => known.has(p)));
    if (docsLoadedFor !== out) layoutFor = null;
    docsLoadedFor = out;
    await loadLayout();
  } catch (e) { $("docs-tree").innerHTML = `<div class="empty-row">${esc(e.message)}</div>`; }
}

async function loadLayout() {
  const key = layoutKey();
  if (layoutFor !== key) {
    const saved = (await api("/api/layout?" + new URLSearchParams({ output: val("output"), repo: key }))).layout;
    if (saved) {
      layout = { folders: new Set(saved.folders), docs: new Map(Object.entries(saved.docs)), known: new Set(saved.known) };
    } else if (layoutFor === null || !layout.docs.size) {
      // Lần đầu: dựng sẵn cấu trúc từ Confluence (bỏ phần thư mục chung) để người dùng chỉ việc chỉnh lại.
      layout = { folders: new Set(), docs: new Map(), known: new Set() };
      autoPlace(docs);
    } // còn lại: vừa chọn repo khác mà chưa có cấu trúc → giữ cấu trúc đang sắp cho repo này.
    layoutFor = key;
    activeFolder = layout.folders.has(activeFolder) ? activeFolder : "";
    if (!saved) saveLayout();
  }
  renderDocs();
}

let saving = Promise.resolve();
function saveLayout() {
  // Lưu ngay mỗi lần thay đổi, nối tiếp nhau để bản cũ không ghi đè bản mới.
  const body = { output: val("output"), repo: layoutKey(), layout: { folders: [...layout.folders], docs: Object.fromEntries(layout.docs), known: [...layout.known] } };
  saving = saving.then(() => api("/api/layout", body)).catch((e) => toast("Không lưu được cách sắp xếp: " + esc(e.message), "err"));
}
function changed() { saveLayout(); renderDocs(); }

function addFolder(path) {
  for (let p = path; p; p = dirName(p)) layout.folders.add(p);
}
function commonDir(paths) {
  const dirs = paths.map((p) => dirName(p).split("/").filter(Boolean));
  if (!dirs.length) return [];
  let n = Math.min(...dirs.map((d) => d.length));
  for (let i = 0; i < n; i++) if (dirs.some((d) => d[i] !== dirs[0][i])) { n = i; break; }
  return dirs[0].slice(0, n);
}
function autoPlace(list) {
  const cut = commonDir(docs.map((d) => d.path)).length;
  for (const d of list) {
    const folder = dirName(d.path).split("/").filter(Boolean).slice(cut).join("/");
    addFolder(folder);
    layout.docs.set(d.key, folder);
    layout.known.add(d.key);
  }
}

const placed = () => docs.filter((d) => layout.docs.has(d.key));
const targetOf = (d) => joinPath(layout.docs.get(d.key), d.name);
function conflicts() {
  const seen = new Map();
  placed().forEach((d) => { const t = targetOf(d).toLowerCase(); seen.set(t, (seen.get(t) || 0) + 1); });
  return new Set([...seen].filter(([, n]) => n > 1).map(([t]) => t));
}

function placeDocs(list, folder) {
  list.forEach((d) => { layout.docs.set(d.key, folder); layout.known.add(d.key); });
  addFolder(folder);
  changed();
}
function placeSourceFolder(cpath, folder) {
  const list = docs.filter((d) => d.path.startsWith(cpath + "/"));
  const root = joinPath(folder, baseName(cpath));
  list.forEach((d) => {
    const sub = joinPath(root, dirName(d.path).slice(cpath.length + 1));
    addFolder(sub);
    layout.docs.set(d.key, sub);
    layout.known.add(d.key);
  });
  addFolder(root);
  changed();
  return list.length;
}
function moveFolder(src, parent) {
  const dest = joinPath(parent, baseName(src));
  if (dest === src) return;
  if (parent === src || parent.startsWith(src + "/")) { toast("Không thể chuyển thư mục vào chính nó.", "err"); return; }
  if (layout.folders.has(dest)) { toast(`Đã có thư mục <b>${esc(dest)}</b>.`, "err"); return; }
  const remap = (p) => (p === src ? dest : p.startsWith(src + "/") ? dest + p.slice(src.length) : p);
  layout.folders = new Set([...layout.folders].map(remap));
  layout.docs.forEach((f, k) => layout.docs.set(k, remap(f)));
  addFolder(dest);
  if (activeFolder === src || activeFolder.startsWith(src + "/")) activeFolder = remap(activeFolder);
  changed();
}
function deleteFolder(path) {
  const inside = (p) => p === path || p.startsWith(path + "/");
  const n = placed().filter((d) => inside(layout.docs.get(d.key))).length;
  if (n && !confirm(`Thư mục "${baseName(path)}" có ${n} tài liệu. Xoá thư mục và đưa các tài liệu này về lại cột Confluence?`)) return;
  layout.folders = new Set([...layout.folders].filter((p) => !inside(p)));
  [...layout.docs].forEach(([k, f]) => inside(f) && layout.docs.delete(k));
  if (inside(activeFolder)) activeFolder = dirName(path);
  changed();
}

function folderDialog({ title, parent, value = "", onSave }) {
  const dlg = $("folder-dialog"), input = $("folder-input"), err = $("folder-error");
  $("folder-title").textContent = title;
  $("folder-parent").innerHTML = `Trong: <code>${esc(rootLabel() + (parent ? "/" + parent : ""))}</code>`;
  input.value = value;
  err.hidden = true;
  $("folder-form").onsubmit = (ev) => {
    ev.preventDefault();
    const name = input.value.trim();
    const bad = !name ? "Tên thư mục không được để trống."
      : /[\\/:*?"<>|]/.test(name) || name === "." || name === ".." ? 'Tên không được chứa các ký tự \\ / : * ? " < > |'
      : name !== value && layout.folders.has(joinPath(parent, name)) ? "Đã có thư mục mang tên này." : null;
    if (bad) { err.textContent = bad; err.hidden = false; return; }
    dlg.close();
    if (name !== value) onSave(name);
  };
  $("folder-cancel").onclick = () => dlg.close();
  dlg.showModal();
  input.select();
}
function newFolder(parent) {
  folderDialog({ title: "Tạo thư mục", parent, onSave: (name) => {
    const path = joinPath(parent, name);
    addFolder(path);
    activeFolder = path;
    tCollapsed.delete(parent);
    changed();
  } });
}
function renameFolder(path) {
  folderDialog({ title: "Đổi tên thư mục", parent: dirName(path), value: baseName(path), onSave: (name) => {
    const dest = joinPath(dirName(path), name);
    const remap = (p) => (p === path ? dest : p.startsWith(path + "/") ? dest + p.slice(path.length) : p);
    layout.folders = new Set([...layout.folders].map(remap));
    layout.docs.forEach((f, k) => layout.docs.set(k, remap(f)));
    activeFolder = remap(activeFolder);
    changed();
  } });
}

function buildTree(items) {
  const root = { name: "", path: "", children: new Map(), docs: [] };
  for (const d of items) {
    const parts = d.path.split("/");
    let node = root;
    parts.slice(0, -1).forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (!node.children.has(part)) node.children.set(part, { name: part, path, children: new Map(), docs: [] });
      node = node.children.get(part);
    });
    node.docs.push(d);
  }
  // Gộp các thư mục chỉ có 1 thư mục con (vd. "Space/Space") cho gọn.
  const squash = (n) => {
    n.children.forEach((c) => squash(c));
    if (n.path && n.docs.length === 0 && n.children.size === 1) {
      const only = [...n.children.values()][0];
      n.name = n.name + " / " + only.name; n.path = only.path; n.children = only.children; n.docs = only.docs;
    }
  };
  root.children.forEach(squash);
  return root;
}
const docsIn = (n) => [...n.docs, ...[...n.children.values()].flatMap(docsIn)];
const byName = (a, b) => a.name.localeCompare(b.name, "vi");

function renderDocs() {
  renderSource();
  renderTarget();
  const sel = placed();
  $("docs-summary").textContent = docs.length
    ? `${sel.length}/${docs.length} tài liệu sẽ push · ${formatBytes(sel.reduce((s, d) => s + d.bytes, 0))}` : "";
}

function renderSource() {
  const q = $("docs-search").value.toLowerCase();
  const shown = docs.filter((d) => (d.path + " " + d.name).toLowerCase().includes(q));
  const pickedDocs = docs.filter((d) => picked.has(d.path));
  $("docs-add").disabled = !pickedDocs.length;
  $("docs-none").hidden = !pickedDocs.length;
  $("docs-add-text").innerHTML = pickedDocs.length
    ? `Đưa ${pickedDocs.length} tài liệu vào <b>${esc(activeFolder ? baseName(activeFolder) : rootLabel())}</b>` : "Tick chọn tài liệu để đưa sang GitHub";
  if (!shown.length) {
    $("docs-tree").innerHTML = `<div class="empty-row">${docs.length ? "Không có tài liệu khớp." : "Chưa có tài liệu nào — hãy export ở bước 2."}</div>`;
    return;
  }
  const renderNode = (n) => {
    const folders = [...n.children.values()].sort(byName).map((c) => {
      const all = docsIn(c), on = all.filter((d) => picked.has(d.path)).length, inGh = all.filter((d) => layout.docs.has(d.key)).length;
      const isCollapsed = collapsed.has(c.path) && !q;
      return `<li class="folder${isCollapsed ? " collapsed" : ""}">
        <div class="row" draggable="true" data-src-folder="${esc(c.path)}" title="Kéo sang cột GitHub để đưa cả thư mục">
          <span class="twisty" data-toggle="${esc(c.path)}">${icon("chevron")}</span>
          <input type="checkbox" data-check-folder="${esc(c.path)}" ${on === all.length ? "checked" : ""} ${on && on < all.length ? 'data-indeterminate="1"' : ""}>
          ${icon("folder")}<span class="label" title="${esc(c.path)}">${esc(c.name)}</span><span class="meta" title="Số tài liệu đã có bên GitHub">${inGh}/${all.length}</span>
        </div>
        <ul>${renderNode(c)}</ul></li>`;
    }).join("");
    const files = n.docs.sort((a, b) => a.path.localeCompare(b.path, "vi")).map((d) => {
      const inGh = layout.docs.has(d.key), isNew = !layout.known.has(d.key);
      return `<li>
        <label class="row${inGh ? " in-gh" : ""}" draggable="true" data-src-doc="${esc(d.path)}">
          <span class="spacer"></span>
          <input type="checkbox" data-check-doc="${esc(d.path)}" ${picked.has(d.path) ? "checked" : ""}>
          ${icon("file")}<span class="label" title="${esc(d.path)}">${esc(docLabel(d))}${d.renamed ? '<span class="renamed-tag">đổi tên</span>' : ""}${isNew ? '<span class="new-tag">mới</span>' : ""}</span>
          <span class="row-actions"><button type="button" data-rename="${esc(d.path)}" title="Đổi tên">${icon("edit")}</button><button type="button" class="del" data-delete="${esc(d.path)}" title="Xoá khỏi máy">${icon("trash")}</button></span>
          ${inGh ? `<span class="gh-tag" title="Trên GitHub: ${esc(targetOf(d))}">${icon("check")}GitHub</span>`
            : `<span class="meta">${formatBytes(d.bytes)}</span>`}
        </label></li>`;
    }).join("");
    return folders + files;
  };
  $("docs-tree").innerHTML = `<ul>${renderNode(buildTree(shown))}</ul>`;
  $("docs-tree").querySelectorAll("[data-indeterminate]").forEach((el) => (el.indeterminate = true));
}

function rootLabel() {
  return joinPath(val("repo") ? val("repo").split("/").pop() : "repo", val("subdir"));
}

function renderTarget() {
  $("tb-repo").textContent = val("repo") ? val("repo").split("/").pop() : "repo";
  const bad = conflicts();
  const root = { name: "", path: "", children: new Map(), docs: [] };
  const node = (path) => {
    let n = root;
    path.split("/").filter(Boolean).forEach((part, i, arr) => {
      if (!n.children.has(part)) n.children.set(part, { name: part, path: arr.slice(0, i + 1).join("/"), children: new Map(), docs: [] });
      n = n.children.get(part);
    });
    return n;
  };
  [...layout.folders].forEach(node);
  placed().forEach((d) => node(layout.docs.get(d.key)).docs.push(d));
  const count = (n) => n.docs.length + [...n.children.values()].reduce((s, c) => s + count(c), 0);
  const renderNode = (n) => [...n.children.values()].sort(byName).map((c) => {
    const isCollapsed = tCollapsed.has(c.path);
    return `<li class="folder${isCollapsed ? " collapsed" : ""}">
      <div class="row t-folder${activeFolder === c.path ? " active" : ""}" draggable="true" data-drop="${esc(c.path)}" data-t-folder="${esc(c.path)}">
        <span class="twisty" data-t-toggle="${esc(c.path)}">${icon("chevron")}</span>
        ${icon("folder")}<span class="label" title="${esc(c.path)}">${esc(c.name)}</span>
        <span class="row-actions">
          <button type="button" data-t-new="${esc(c.path)}" title="Tạo thư mục con">${icon("plus")}</button>
          <button type="button" data-t-rename="${esc(c.path)}" title="Đổi tên thư mục">${icon("edit")}</button>
          <button type="button" class="del" data-t-delete="${esc(c.path)}" title="Xoá thư mục">${icon("trash")}</button></span>
        <span class="meta">${count(c) || ""}</span>
      </div>
      <ul>${renderNode(c)}</ul></li>`;
  }).join("") + n.docs.sort(byName).map((d) => {
    const clash = bad.has(targetOf(d).toLowerCase());
    return `<li><div class="row t-doc${clash ? " clash" : ""}" draggable="true" data-t-doc="${esc(d.key)}" data-drop="${esc(n.path)}">
      <span class="spacer"></span>${icon(clash ? "alert" : "file")}<span class="label" title="${esc(targetOf(d))}">${esc(d.name)}</span>
      <span class="row-actions"><button type="button" data-rename="${esc(d.path)}" title="Đổi tên">${icon("edit")}</button><button type="button" class="del" data-t-remove="${esc(d.key)}" title="Bỏ khỏi GitHub">${icon("x")}</button></span>
      ${d.assets ? `<span class="meta">${d.assets} tệp</span>` : ""}</div></li>`;
  }).join("");
  const body = renderNode(root);
  $("target-tree").innerHTML = `<div class="row t-root${activeFolder === "" ? " active" : ""}" data-drop="" data-t-folder="">
      <svg class="gh-mark" viewBox="0 0 16 16"><use href="#i-github"/></svg><span class="label">${esc(rootLabel())}</span>
      <span class="row-actions"><button type="button" data-t-new="" title="Tạo thư mục">${icon("plus")}</button></span>
      <span class="meta">${placed().length || ""}</span></div>
    <ul>${body}</ul>${body ? "" : `<div class="empty-row drop-hint">Kéo tài liệu từ cột Confluence thả vào đây,<br>hoặc bấm <b>+ Thư mục</b> để tạo cấu trúc trước.</div>`}`;
  $("target-note").innerHTML = bad.size
    ? `<span class="err-text">${icon("alert")}Có tài liệu trùng tên trong cùng thư mục — hãy đổi tên hoặc chuyển sang thư mục khác.</span>`
    : placed().length ? `Bấm vào thư mục để chọn nơi đặt · kéo thả để di chuyển · thả tài liệu về cột Confluence để bỏ khỏi GitHub.` : "";
  const fresh = docs.filter((d) => !layout.known.has(d.key));
  $("new-docs").hidden = !fresh.length;
  if (fresh.length) {
    $("new-docs").innerHTML = `${icon("info")}<span><b>${fresh.length} tài liệu mới</b> từ Confluence chưa được xếp vào GitHub.</span>
      <button type="button" class="ghost small" data-new="auto">Tự động xếp</button><button type="button" class="ghost small" data-new="skip">Để sau</button>`;
  }
}

// -- thao tác cột Confluence
$("docs-tree").addEventListener("click", (ev) => {
  const action = ev.target.closest("[data-rename],[data-delete]");
  if (action) {
    ev.preventDefault();
    const doc = docs.find((d) => d.path === (action.dataset.rename || action.dataset.delete));
    if (doc) action.dataset.rename ? renameDoc(doc) : deleteDoc(doc);
    return;
  }
  const toggle = ev.target.closest("[data-toggle]");
  if (toggle) {
    const p = toggle.dataset.toggle;
    collapsed.has(p) ? collapsed.delete(p) : collapsed.add(p);
    renderSource();
    return;
  }
  const row = ev.target.closest(".row[data-src-folder]");
  if (row && !ev.target.matches("input")) row.querySelector("input").click();
});
$("docs-tree").addEventListener("change", (ev) => {
  const el = ev.target;
  if (el.dataset.checkDoc) {
    el.checked ? picked.add(el.dataset.checkDoc) : picked.delete(el.dataset.checkDoc);
  } else if (el.dataset.checkFolder) {
    const prefix = el.dataset.checkFolder + "/";
    const q = $("docs-search").value.toLowerCase();
    docs.filter((d) => d.path.startsWith(prefix) && d.path.toLowerCase().includes(q))
      .forEach((d) => (el.checked ? picked.add(d.path) : picked.delete(d.path)));
  }
  renderSource();
});
$("docs-search").addEventListener("input", renderSource);
$("docs-reload").addEventListener("click", () => loadDocs(true));
$("docs-none").addEventListener("click", () => { picked.clear(); renderSource(); });
$("docs-add").addEventListener("click", () => {
  const list = docs.filter((d) => picked.has(d.path));
  placeDocs(list, activeFolder);
  picked.clear();
  renderSource();
  toast(`Đã đưa ${list.length} tài liệu vào <b>${esc(activeFolder || rootLabel())}</b>.`, "ok");
});

// -- thao tác cột GitHub
$("target-tree").addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (b) {
    ev.stopPropagation();
    const d = b.dataset;
    if ("tNew" in d) newFolder(d.tNew);
    else if (d.tRename) renameFolder(d.tRename);
    else if (d.tDelete) deleteFolder(d.tDelete);
    else if (d.tRemove) { layout.docs.delete(d.tRemove); changed(); }
    else if (d.rename) { const doc = docs.find((x) => x.path === d.rename); if (doc) renameDoc(doc); }
    return;
  }
  const toggle = ev.target.closest("[data-t-toggle]");
  if (toggle) {
    const p = toggle.dataset.tToggle;
    tCollapsed.has(p) ? tCollapsed.delete(p) : tCollapsed.add(p);
    renderTarget();
    return;
  }
  const folder = ev.target.closest("[data-t-folder]");
  if (folder) { activeFolder = folder.dataset.tFolder; renderDocs(); }
});
$("tree-new-folder").addEventListener("click", () => newFolder(activeFolder));
$("tree-auto").addEventListener("click", () => {
  const list = docs.filter((d) => !layout.docs.has(d.key));
  if (!list.length) { toast("Mọi tài liệu đã nằm bên cột GitHub.", "info"); return; }
  autoPlace(list);
  changed();
  toast(`Đã tự động xếp ${list.length} tài liệu.`, "ok");
});
$("tree-clear").addEventListener("click", () => {
  if (!layout.docs.size && !layout.folders.size) return;
  if (!confirm("Làm trống cột GitHub? Mọi thư mục và vị trí tài liệu đã sắp cho repo này sẽ bị xoá (file trên GitHub không bị ảnh hưởng).")) return;
  layout.folders.clear();
  layout.docs.clear();
  activeFolder = "";
  changed();
});
$("new-docs").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-new]");
  if (!b) return;
  const fresh = docs.filter((d) => !layout.known.has(d.key));
  if (b.dataset.new === "auto") autoPlace(fresh);
  else fresh.forEach((d) => layout.known.add(d.key));
  changed();
});

// -- kéo thả
document.addEventListener("dragstart", (ev) => {
  const el = ev.target.closest?.("[draggable]");
  if (!el) return;
  const d = el.dataset;
  if (d.srcDoc) {
    // Kéo một tài liệu đang được tick → kéo cả nhóm đã tick.
    const list = picked.has(d.srcDoc) ? docs.filter((x) => picked.has(x.path)) : docs.filter((x) => x.path === d.srcDoc);
    dragging = { kind: "docs", list };
  } else if (d.srcFolder) dragging = { kind: "src-folder", path: d.srcFolder };
  else if (d.tDoc) dragging = { kind: "docs", list: docs.filter((x) => x.key === d.tDoc), fromTarget: true };
  else if (d.tFolder) dragging = { kind: "t-folder", path: d.tFolder };
  else return;
  ev.dataTransfer.effectAllowed = "move";
  ev.dataTransfer.setData("text/plain", "");
  if (dragging.kind === "docs" && dragging.list.length > 1) {
    const ghost = Object.assign(document.createElement("div"), { className: "drag-ghost", textContent: `${dragging.list.length} tài liệu` });
    document.body.appendChild(ghost);
    ev.dataTransfer.setDragImage(ghost, 10, 10);
    setTimeout(() => ghost.remove());
  }
});
document.addEventListener("dragend", () => {
  dragging = null;
  document.querySelectorAll(".drop-over").forEach((x) => x.classList.remove("drop-over"));
});
function dropZone(ev) {
  if (!dragging) return null;
  if (ev.target.closest("#docs-tree")) return dragging.fromTarget ? $("docs-tree") : null;
  if (!ev.target.closest("#target-tree")) return null;
  return ev.target.closest("[data-drop]") || $("target-tree");
}
document.addEventListener("dragover", (ev) => {
  const zone = dropZone(ev);
  document.querySelectorAll(".drop-over").forEach((x) => x !== zone && x.classList.remove("drop-over"));
  if (!zone) return;
  ev.preventDefault();
  zone.classList.add("drop-over");
});
document.addEventListener("drop", (ev) => {
  const zone = dropZone(ev);
  if (!zone) return;
  ev.preventDefault();
  zone.classList.remove("drop-over");
  const drag = dragging;
  dragging = null;
  if (zone === $("docs-tree")) {
    drag.list.forEach((d) => layout.docs.delete(d.key));
    changed();
    return;
  }
  const folder = zone.dataset.drop ?? "";
  if (drag.kind === "docs") placeDocs(drag.list, folder);
  else if (drag.kind === "src-folder") toast(`Đã đưa ${placeSourceFolder(drag.path, folder)} tài liệu vào <b>${esc(joinPath(folder, baseName(drag.path)))}</b>.`, "ok");
  else if (drag.kind === "t-folder") moveFolder(drag.path, folder);
  tCollapsed.delete(folder);
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
  if (!placed().length) { toast("Hãy kéo ít nhất một tài liệu sang cột GitHub để push.", "err"); return; }
  if (conflicts().size) { toast("Có tài liệu trùng tên trong cùng thư mục bên cột GitHub — hãy xử lý trước khi push.", "err"); return; }
  if (!selectedRepo.private && !(await confirmPublic())) return;
  const btn = $("btn-push");
  busy(btn, true);
  $("push-result").hidden = true;
  $("push-error").hidden = true;
  try {
    await api("/api/push", {
      repo: selectedRepo.full_name, branch: val("branch"), subdir: val("subdir"),
      message: val("message"), output: val("output"), allow_public: !selectedRepo.private,
      layout: Object.fromEntries(placed().map((d) => [d.path, layout.docs.get(d.key)])),
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
    if (location.hash === "#github") loadDocs(true);
    const job = await api("/api/job");
    if (job.running) {
      busy($(job.kind === "push" ? "btn-push" : "btn-export"), true);
      startPolling(job.kind);
    }
  } catch (e) { toast(esc(e.message), "err"); }
})();
