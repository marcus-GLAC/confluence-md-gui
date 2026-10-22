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
        ${group("err", "File lớn hơn 100MB", "GitHub từ chối các file này, chúng sẽ được bỏ qua khi push.", r.too_big, (f) => esc(f))}
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
let repoPublic = null;
async function checkRepo() {
  const r = await api("/api/github-check", { repo: val("repo"), gh_token: val("gh_token") });
  repoPublic = !r.private;
  const tag = r.private ? `<span class="tag private">${icon("lock")}Private</span>` : `<span class="tag public">${icon("alert")}Public</span>`;
  statusBox("repo-status", r.private ? "ok" : "warn",
    `Đã truy cập <b>${esc(r.full_name)}</b> ${tag} · nhánh mặc định <code>${esc(r.default_branch)}</code>` +
    (r.private ? "" : "<br>Tài liệu sẽ công khai với mọi người sau khi push."));
  if (!val("branch")) $("branch").value = r.default_branch;
  return r;
}
$("btn-gh-check").addEventListener("click", async () => {
  if (!requireFields(["repo", "gh_token"])) return;
  const btn = $("btn-gh-check");
  busy(btn, true);
  try { await checkRepo(); } catch (e) { statusBox("repo-status", "err", esc(e.message)); }
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
  if (!requireFields(["repo", "gh_token"])) return;
  if (!val("output")) { toast("Chưa có thư mục kết quả. Hãy export ở bước 2.", "err"); goto("export"); return; }
  const btn = $("btn-push");
  busy(btn, true);
  $("push-result").hidden = true;
  try {
    await checkRepo();
    if (repoPublic && !(await confirmPublic())) { busy(btn, false); return; }
    await api("/api/push", {
      repo: val("repo"), branch: val("branch"), gh_token: val("gh_token"), subdir: val("subdir"),
      message: val("message"), output: val("output"), allow_public: repoPublic,
    });
    startPolling("push");
  } catch (e) {
    busy(btn, false);
    statusBox("repo-status", "err", esc(e.message));
  }
});

jobHandlers.push = (job) => {
  busy($("btn-push"), false);
  if (!job.ok) {
    toast("Push không thành công. Xem chi tiết trong <b>Nhật ký hoạt động</b>.", "err");
    return;
  }
  markDone("github");
  const n = job.result?.files ?? 0;
  $("push-result-text").textContent = n ? `${n} file mới hoặc đã thay đổi được tải lên.` : "Không có thay đổi nào so với GitHub.";
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
    const job = await api("/api/job");
    if (job.running) {
      busy($(job.kind === "push" ? "btn-push" : "btn-export"), true);
      startPolling(job.kind);
    }
  } catch (e) { toast(esc(e.message), "err"); }
})();
