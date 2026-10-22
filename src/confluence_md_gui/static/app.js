const $ = (id) => document.getElementById(id);
const val = (id) => $(id).value.trim();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---- tabs
document.querySelectorAll(".tabs button").forEach((btn) => btn.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + btn.dataset.tab));
  if (btn.dataset.tab === "preview") loadTree();
}));

// ---- log & job polling
let logTotal = 0, polling = null;
function log(line) {
  const el = $("log");
  el.textContent += line + "\n";
  el.scrollTop = el.scrollHeight;
}
function setStatus(text, cls) { $("status").textContent = text; $("status").className = cls || ""; }

function startPolling() {
  logTotal = 0;
  $("log").textContent = "";
  setStatus("Đang chạy…", "run");
  clearInterval(polling);
  polling = setInterval(async () => {
    try {
      const job = await api("/api/job?since=" + logTotal);
      job.lines.forEach(log);
      logTotal = job.total;
      if (!job.running) {
        clearInterval(polling);
        setStatus(job.ok ? "Hoàn tất" : "Thất bại", job.ok ? "ok" : "err");
        document.querySelectorAll(".primary").forEach((b) => (b.disabled = false));
      }
    } catch (e) { log("⚠ " + e.message); }
  }, 700);
}

async function runJob(path, body) {
  try {
    document.querySelectorAll(".primary").forEach((b) => (b.disabled = true));
    await api(path, body);
    startPolling();
  } catch (e) {
    document.querySelectorAll(".primary").forEach((b) => (b.disabled = false));
    setStatus("Lỗi", "err");
    log("❌ " + e.message);
  }
}

document.querySelectorAll(".btn-cancel").forEach((b) => b.addEventListener("click", () => api("/api/cancel", {})));

// ---- export
$("btn-export").addEventListener("click", () => runJob("/api/export", {
  base_url: val("base_url"), email: val("email"), token: val("token"),
  mode: $("mode").value, target_url: val("target_url"), output: val("output"),
}));

// ---- link check
$("btn-links").addEventListener("click", async () => {
  const box = $("links-report");
  box.innerHTML = '<p class="muted">Đang quét…</p>';
  try {
    const r = await api("/api/check-links", { output: val("output"), strip_query: $("strip_query").checked });
    const bad = r.remote.length + r.missing.length;
    const list = (title, items, fmt) => items.length
      ? `<h3>${title} (${items.length})</h3><ul>${items.slice(0, 300).map((i) => `<li>${fmt(i)}</li>`).join("")}</ul>` : "";
    const item = (i) => `<code>${esc(i.file)}</code> → ${esc(i.src)}`;
    box.innerHTML = `
      <div class="summary">
        <div class="stat"><b>${r.files}</b>file .md</div>
        <div class="stat"><b>${r.images}</b>ảnh</div>
        <div class="stat ${bad ? "err" : "ok"}"><b>${bad}</b>ảnh sẽ lỗi trên GitHub</div>
        <div class="stat ${r.query.length ? "warn" : "ok"}"><b>${r.query.length}</b>link có ?query</div>
      </div>
      ${r.fixed ? `<p>✅ Đã sửa ${r.fixed} file (xoá ?query khỏi link ảnh).</p>` : ""}
      <div class="issues">
        ${list("Ảnh trỏ về web ngoài / Confluence (cần đăng nhập nên GitHub không hiện)", r.remote, item)}
        ${list("Ảnh không tìm thấy file trong thư mục", r.missing, item)}
        ${list("Link ảnh có ?query ở cuối", r.query, item)}
        ${list("File lớn hơn 100MB (GitHub từ chối)", r.too_big, (f) => esc(f))}
      </div>
      ${!bad && !r.too_big.length ? "<p>✅ Không phát hiện vấn đề — ảnh sẽ hiển thị trên GitHub.</p>" : ""}`;
  } catch (e) { box.innerHTML = `<p style="color:var(--err)">❌ ${esc(e.message)}</p>`; }
});

// ---- preview
let files = [];
async function loadTree() {
  try {
    files = (await api("/api/tree?output=" + encodeURIComponent(val("output")))).files;
    renderTree();
  } catch (e) { $("file-list").innerHTML = `<li>❌ ${esc(e.message)}</li>`; }
}
function renderTree() {
  const f = $("filter").value.toLowerCase();
  const shown = files.filter((p) => p.toLowerCase().includes(f));
  $("file-list").innerHTML = shown.length
    ? shown.map((p) => `<li data-path="${esc(p)}">${esc(p)}</li>`).join("")
    : '<li class="muted">Chưa có file .md nào.</li>';
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
  } catch (e) { $("preview-body").innerHTML = `<p>❌ ${esc(e.message)}</p>`; }
});

// ---- github
$("btn-gh-check").addEventListener("click", async () => {
  try {
    const r = await api("/api/github-check", { repo: val("repo"), gh_token: val("gh_token") });
    $("repo-info").innerHTML = `<b>${esc(r.full_name)}</b> · nhánh mặc định <code>${esc(r.default_branch)}</code> · ` +
      (r.private ? '<span class="badge private">PRIVATE</span>' : '<span class="badge public">PUBLIC – ai cũng xem được</span>');
  } catch (e) { $("repo-info").innerHTML = `<span style="color:var(--err)">❌ ${esc(e.message)}</span>`; }
});
$("btn-push").addEventListener("click", () => runJob("/api/push", {
  repo: val("repo"), branch: val("branch"), gh_token: val("gh_token"), subdir: val("subdir"),
  message: val("message"), output: val("output"), allow_public: $("allow_public").checked,
}));

// ---- init
(async () => {
  try {
    const s = await api("/api/settings");
    for (const k of ["base_url", "email", "output", "repo", "branch", "subdir"]) if (s[k]) $(k).value = s[k];
    const job = await api("/api/job");
    if (job.running) startPolling();
  } catch (e) { log("⚠ " + e.message); }
})();
