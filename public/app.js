// DevJavu — collapsed timeline, day view with scroll-driven time track

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  entries: [],
  score: null,
  mode: "local",
  filterDate: null,
  calYear: 0,
  calMonth: 0,
};

const today = () => new Date().toISOString().slice(0, 10);
const nowTime = () => new Date().toTimeString().slice(0, 5);
const pad2 = (n) => String(n).padStart(2, "0");

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function parseMarkdown(s) {
  if (!s) return "";
  let html = escapeHtml(s);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => renderCodeBlock(lang, code));
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  html = html.split(/\n\n+/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
  return html;
}

function tokenize(code, order) {
  const parts = order.map(([cls, p]) => `(?:${p.source})`);
  const combined = new RegExp(parts.join("|"), "g");
  let out = "";
  let lastIdx = 0;
  let m;
  while ((m = combined.exec(code)) !== null) {
    out += escapeHtml(code.slice(lastIdx, m.index));
    let cls = null;
    for (let i = 0; i < order.length; i++) {
      if (m[i + 1] !== undefined) { cls = order[i][0]; break; }
    }
    if (cls) {
      out += `<span class="tok-${cls}">${escapeHtml(m[0])}</span>`;
    } else {
      out += escapeHtml(m[0]);
    }
    lastIdx = m.index + m[0].length;
  }
  out += escapeHtml(code.slice(lastIdx));
  return out;
}

function renderCodeBlock(lang, code) {
  const language = lang || "code";
  const normalizedCode = code.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const lines = normalizedCode.split("\n");
  const order = [
    ["com", /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g],
    ["str", /(["'`])(?:\\.|(?!\1).)*\1/g],
    ["num", /\b(\d+\.?\d*)\b/g],
    ["kw",  /\b(const|let|var|function|return|if|else|for|while|class|extends|import|export|from|new|this|async|await|try|catch|throw|typeof|interface|type|public|private|protected|static|void|null|true|false|undefined|in|of|as|do|switch|case|break|continue|yield|delete)\b/g],
    ["fn",  /\b([a-zA-Z_$][\w$]*)(?=\()/g],
  ];
  const highlighted = tokenize(normalizedCode, order);
  const lineHtml = lines.map((_, i) => `<span class="code-line"><span class="code-line-num">${i + 1}</span>${highlighted.split("\n")[i] || "&nbsp;"}</span>`).join("");
  return `<div class="code-block"><div class="code-header"><span class="code-lang">${escapeHtml(language)}</span><button class="code-copy" data-copy>copy</button></div><pre><code>${lineHtml}</code></pre></div>`;
}

async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
  return res.json();
}

/* ── Router ───────────────────────────── */

function showView(name) {
  if (name === "home") {
    state.filterDate = null;
    $("#day-entries").innerHTML = "";
    $(".day-progress")?.remove();
  }
  $$(".view").forEach((v) => {
    v.classList.add("hidden");
    v.hidden = true;
  });
  const target = document.getElementById("view-" + name);
  if (target) {
    target.classList.remove("hidden");
    target.hidden = false;
  }
  const scrollControls = $("#day-scroll-controls");
  if (scrollControls) scrollControls.hidden = name !== "day";
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name === "day") updateDayProgress();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  if (h.startsWith("day/")) return { view: "day", date: h.slice(4) };
  if (h.startsWith("entry/")) return { view: "entry", id: h.slice(6) };
  if (h === "calendar") return { view: "calendar" };
  return { view: "home" };
}

function navigate(hash) {
  if (location.hash === hash) handleRoute();
  else location.hash = hash;
}

function handleRoute() {
  const route = parseHash();
  if (route.view === "day") {
    renderDayView(route.date);
    showView("day");
  } else if (route.view === "entry") {
    renderEntryDetail(route.id);
    showView("entry");
  } else if (route.view === "calendar") {
    renderCalendar();
    showView("calendar");
  } else {
    showView("home");
  }
}

window.addEventListener("hashchange", handleRoute);

function updateDayProgress() {
  const view = $("#view-day");
  const entries = $$("#day-entries .day-entry-block");
  if (!view || !entries.length || view.classList.contains("hidden")) return;

  const viewportPoint = window.innerHeight * 0.42;
  const readingPosition = viewportPoint;
  const scrollRange = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  const progress = Math.max(0, Math.min(1, window.scrollY / scrollRange));
  view.style.setProperty("--day-progress", progress.toFixed(3));
  let active = entries[entries.length - 1];
  for (const entry of entries) {
    const rect = entry.getBoundingClientRect();
    if (rect.top <= readingPosition && rect.bottom > readingPosition) {
      active = entry;
      break;
    }
    if (rect.top > readingPosition) {
      active = entry;
      break;
    }
  }
  entries.forEach((entry) => entry.classList.toggle("is-active", entry === active));
}

window.addEventListener("scroll", updateDayProgress, { passive: true });

function scrollDayBy(direction) {
  const amount = Math.max(240, Math.round(window.innerHeight * 0.78));
  window.scrollBy({ top: direction * amount, behavior: "smooth" });
}

$("#day-scroll-up")?.addEventListener("click", () => scrollDayBy(-1));
$("#day-scroll-down")?.addEventListener("click", () => scrollDayBy(1));

/* ── Home timeline (collapsed day cards) ─ */

function groupByDay(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.date)) groups.set(e.date, []);
    groups.get(e.date).push(e);
  }
  return Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0]));
}

function formatDayName(date) {
  const d = new Date(date + "T00:00:00");
  const t = today();
  if (date === t) return "Today";
  const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (date === y) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function formatDayDow(date) {
  return new Date(date + "T00:00:00").toLocaleDateString("en-US", { weekday: "short" });
}

function formatDayNum(date) {
  return new Date(date + "T00:00:00").getDate();
}

function snippetOf(body, max = 160) {
  if (!body) return "";
  let s = body.replace(/```[\s\S]*?```/g, "[code]").replace(/`([^`]+)`/g, "$1").replace(/\n+/g, " ").trim();
  return s.length > max ? s.slice(0, max).trim() + "…" : s;
}

function timeRange(dayEntries) {
  if (!dayEntries.length) return "";
  const times = dayEntries.map((e) => e.time).sort();
  return `${times[0]}${times.length > 1 ? " – " + times[times.length - 1] : ""}`;
}

function collectTags(entries) {
  const set = new Set();
  for (const e of entries) (e.tags || []).forEach((t) => set.add(t));
  return Array.from(set).slice(0, 4);
}

function renderDayCard(date, dayEntries) {
  const isToday = date === today();
  return `
    <button class="day-card${isToday ? " today" : ""}" data-date="${date}">
      <div class="day-time">
        <span class="day-time-dow">${formatDayDow(date)}</span>
        <span class="day-time-day">${formatDayNum(date)}</span>
      </div>
      <div class="day-main">
        <div class="day-label-row">
          <span class="day-name">${formatDayName(date)}</span>
          <span class="day-count">· ${dayEntries.length} ${dayEntries.length === 1 ? "entry" : "entries"}</span>
          <span class="day-time-range">${timeRange(dayEntries)}</span>
        </div>
      </div>
      <div class="day-card-arrow">→</div>
    </button>
  `;
}

function renderTimelineEntry(entry) {
  const isToday = entry.date === today();
  return `
    <button class="day-card timeline-entry-card${isToday ? " today" : ""}" data-date="${entry.date}">
      <div class="day-time">
        <span class="day-time-dow">${formatDayDow(entry.date)}</span>
        <span class="day-time-day">${formatDayNum(entry.date)}</span>
      </div>
      <div class="day-main">
        <div class="day-label-row">
          <span class="day-name">${escapeHtml(entry.title)}</span>
          <span class="day-time-range">${escapeHtml(entry.time)}</span>
        </div>
        <div class="timeline-snippet">${escapeHtml(snippetOf(entry.body))}</div>
      </div>
      <div class="day-card-arrow">→</div>
    </button>
  `;
}

function renderTimeline(entries) {
  const root = $("#timeline");
  if (!entries.length) {
    root.innerHTML = `<div class="empty"><div class="empty-title">Nothing here yet</div><p>Press <b>+ new entry</b> to log your first activity.</p></div>`;
    $("#entry-count").textContent = "";
    return;
  }
  const grouped = groupByDay(entries);
  const recent = grouped.slice(0, 4);
  $("#entry-count").textContent = grouped.length > recent.length
    ? `showing ${recent.length} of ${grouped.length} days`
    : `${recent.length} days`;
  root.innerHTML = recent.map(([date, dayEntries]) => renderDayCard(date, dayEntries)).join("");
}

function applyFilter() {
  const filtered = state.filterDate
    ? state.entries.filter((e) => e.date === state.filterDate)
    : state.entries;
  renderTimeline(filtered);
  $("#timeline-title").textContent = state.filterDate
    ? new Date(state.filterDate + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })
    : "Timeline";
}

/* ── Week widget ──────────────────────── */

function renderWeek() {
  const grid = $("#week-grid");
  if (!grid) return;
  const now = new Date();
  const days = [];
  for (let i = 3; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const count = state.entries.filter((e) => e.date === dateStr).length;
    days.push({ date: dateStr, count, isToday: dateStr === today() });
  }
  const max = Math.max(1, ...days.map((d) => d.count));
  const totalWeek = days.reduce((s, d) => s + d.count, 0);
  const goal = 14;
  const reached = totalWeek >= goal;

  grid.innerHTML = days.map((d) => {
    const intensity = d.count / max;
    const h = Math.max(24, intensity * 100);
    const classes = ["week-cell"];
    if (d.count > 0) classes.push("has-data");
    if (d.isToday) classes.push("today");
    const dow = new Date(d.date + "T00:00:00").toLocaleDateString("en-US", { weekday: "narrow" });
    return `<div class="${classes.join(" ")}" style="height: ${h}px" title="${d.date}: ${d.count}"><span class="wc-count">${d.count || ""}</span><span class="wc-label">${dow}</span></div>`;
  }).join("");

  // Add a legend below the grid
  const legend = document.querySelector(".week-widget .week-legend");
  if (legend) {
    legend.innerHTML = reached
      ? `<span><b>${totalWeek}</b> entries this week</span><span>goal hit</span>`
      : `<span><b>${totalWeek}</b> of ${goal}</span><span>this week</span>`;
  }
}

function renderContributionMap() {
  const map = $("#contribution-map");
  const months = $("#contribution-months");
  if (!map || !months) return;

  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 364);
  start.setDate(start.getDate() - start.getDay());
  const counts = new Map();
  for (const entry of state.entries) counts.set(entry.date, (counts.get(entry.date) || 0) + 1);

  const cells = [];
  const monthLabels = [];
  let cursor = new Date(start);
  let total = 0;
  while (cursor <= end) {
    const weekStart = new Date(cursor);
    for (let day = 0; day < 7; day += 1) {
      const date = new Date(weekStart);
      date.setDate(date.getDate() + day);
      const dateStr = date.toISOString().slice(0, 10);
      const count = date <= end && date >= start ? (counts.get(dateStr) || 0) : 0;
      total += count;
      cells.push({ date: dateStr, count, outside: date > end || date < start });
    }
    if (weekStart.getDate() <= 7 || weekStart.getDate() === 1) {
      monthLabels.push({ label: weekStart.toLocaleDateString("en-US", { month: "short" }), offset: cells.length / 7 });
    }
    cursor.setDate(cursor.getDate() + 7);
  }
  const max = Math.max(1, ...cells.map((cell) => cell.count));
  const level = (count) => count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));

  map.innerHTML = cells.map((cell) => `<span class="contribution-cell level-${level(cell.count)}${cell.outside ? " outside" : ""}" title="${cell.date}: ${cell.count}"></span>`).join("");
  months.innerHTML = monthLabels.map((month) => `<span style="--month-offset: ${month.offset}">${month.label}</span>`).join("");
  $("#contribution-total").textContent = `${total} contributions`;
}

/* ── Calendar ─────────────────────────── */

function densityFor(count) {
  if (count === 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  return 3;
}

function renderCalendar() {
  const y = state.calYear, m = state.calMonth;
  const first = new Date(y, m, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const daysInPrev = new Date(y, m, 0).getDate();
  $("#cal-month").textContent = first.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const entriesByDate = new Map();
  for (const e of state.entries) {
    if (!entriesByDate.has(e.date)) entriesByDate.set(e.date, []);
    entriesByDate.get(e.date).push(e);
  }

  const cells = [];
  for (let i = startDow - 1; i >= 0; i--) {
    cells.push({ y: m === 0 ? y - 1 : y, m: m === 0 ? 11 : m - 1, d: daysInPrev - i, outside: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ y, m, d, outside: false });
  }
  const trailing = 42 - cells.length;
  for (let i = 1; i <= trailing; i++) {
    cells.push({ y: m === 11 ? y + 1 : y, m: m === 11 ? 0 : m + 1, d: i, outside: true });
  }

  const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let html = dows.map((d) => `<div class="cal-dow">${d}</div>`).join("");
  const t = today();
  for (const c of cells) {
    const dateStr = `${c.y}-${pad2(c.m + 1)}-${pad2(c.d)}`;
    const count = c.outside ? 0 : (entriesByDate.get(dateStr)?.length || 0);
    const density = densityFor(count);
    const isToday = dateStr === t;
    const classes = ["cal-cell"];
    if (c.outside) classes.push("outside");
    if (isToday) classes.push("today");
    if (count > 0) classes.push("has-entries");
    html += `<button class="${classes.join(" ")}" data-date="${dateStr}">
      <span class="cal-num">${c.d}</span>
      ${count > 0 ? `<span class="cal-meta"><span class="dot dot-${density}"></span>${count}</span>` : ""}
    </button>`;
  }
  $("#cal-grid").innerHTML = html;
}

function shiftMonth(delta) {
  let m = state.calMonth + delta, y = state.calYear;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  state.calMonth = m; state.calYear = y;
  renderCalendar();
}

function renderDayView(date) {
  const dayBody = $("#view-day .day-view-body");
  if (!dayBody.querySelector(".day-progress")) {
    dayBody.insertAdjacentHTML("afterbegin", `<aside class="day-progress" aria-label="Day progress"><div class="day-progress-track"><span class="day-progress-fill"></span></div></aside>`);
  }
  const entries = state.entries
    .filter((e) => e.date === date)
    .sort((a, b) => (a.time || "").localeCompare(b.time || ""));

  if (!entries.length) {
    $("#day-view-date").textContent = formatDayName(date);
    $("#day-view-stats").innerHTML = "";
    $("#day-entries").innerHTML = `<div class="empty"><div class="empty-title">No entries for this day</div></div>`;
    return;
  }

  const d = new Date(date + "T00:00:00");
  $("#day-view-date").textContent = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const allTags = new Set(entries.flatMap((e) => e.tags || []));
  const hours = entries.map((e) => { const [h, m] = e.time.split(":").map(Number); return h + m / 60; });
  const span = hours.length > 1 ? Math.max(...hours) - Math.min(...hours) : 0;
  $("#day-view-stats").innerHTML = `<span><b>${entries.length}</b> entries</span><span><b>${timeRange(entries)}</b></span><span><b>${span > 0 ? span.toFixed(1) + "h" : "—"}</b> span</span><span><b>${allTags.size}</b> tags</span>`;

  $("#day-entries").innerHTML = entries.map((e) => {
    const fileHtml = e.files?.length
      ? `<div class="day-entry-files">${e.files.map((f) => {
          const name = typeof f === "string" ? f : f.name;
          return `<button class="file-card" type="button" data-file='${escapeHtml(JSON.stringify(f))}'><div class="file-icon">${fileIcon(name)}</div><div class="file-meta"><span class="file-name">${escapeHtml(name)}</span><span class="file-size">preview</span></div></button>`;
        }).join("")}</div>`
      : "";
    const tagHtml = e.tags?.length
      ? `<div class="day-entry-tags">${e.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>`
      : "";
    return `
      <article class="day-entry-block" data-time="${e.time}">
        <div class="day-entry-time-column">
          <time class="day-entry-time">${escapeHtml(e.time)}</time>
        </div>
        <div class="day-entry-spine" aria-hidden="true"></div>
        <div class="day-entry-content">
          <div class="day-entry-head">
            <h2 class="day-entry-title">${escapeHtml(e.title)}</h2>
            <div class="day-entry-actions">
              <button class="entry-action" type="button" data-edit-entry="${e.id}">Edit</button>
              <button class="entry-action danger" type="button" data-delete-entry="${e.id}">Delete</button>
            </div>
          </div>
          <div class="day-entry-body">${parseMarkdown(e.body)}</div>
          ${fileHtml}${tagHtml}
        </div>
      </article>
    `;
  }).join("");
  updateDayProgress();
}

function fileIcon(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["png","jpg","jpeg","gif","svg","webp"].includes(ext)) return "img";
  if (["mp4","mov","webm","avi"].includes(ext)) return "vid";
  if (["mp3","wav","ogg","m4a"].includes(ext)) return "aud";
  if (["pdf"].includes(ext)) return "pdf";
  if (["md","markdown"].includes(ext)) return "md";
  if (["js","ts","jsx","tsx","mjs"].includes(ext)) return "js";
  if (["py","rb","go","rs","java","kt","swift","c","cpp","h","hpp"].includes(ext)) return "code";
  if (["json","xml","yaml","yml","toml"].includes(ext)) return "data";
  if (["zip","tar","gz","7z","rar"].includes(ext)) return "zip";
  return "file";
}

function attachmentName(file) {
  return typeof file === "string" ? file : (file?.name || "attachment");
}

function openAttachment(rawFile) {
  let file = rawFile;
  try { file = JSON.parse(rawFile); } catch { /* filename-only legacy attachment */ }
  const name = attachmentName(file);
  const body = $("#preview-body");
  $("#preview-title").textContent = name;
  body.innerHTML = "";
  if (typeof file === "string" || !file.content) {
    body.innerHTML = `<div class="empty"><div class="empty-title">Preview unavailable</div><p>This older attachment only has a filename saved.</p></div>`;
  } else if (file.encoding === "data-url" || String(file.type).startsWith("image/")) {
    const image = document.createElement("img");
    image.className = "attachment-image";
    image.alt = name;
    image.src = file.content;
    body.appendChild(image);
    } else if (["md", "markdown"].includes(name.split(".").pop()?.toLowerCase() || "")) {
      const markdown = document.createElement("div");
      markdown.className = "attachment-markdown";
      markdown.innerHTML = parseMarkdown(file.content);
      body.appendChild(markdown);
  } else {
    const code = document.createElement("pre");
    code.className = "attachment-code";
    const ext = name.split(".").pop()?.toLowerCase() || "";
    const codeTypes = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "cpp", "h", "hpp", "json", "xml", "html", "css", "scss", "sql", "sh", "bash", "yaml", "yml", "toml", "md", "markdown", "txt", "log"];
    code.innerHTML = codeTypes.includes(ext)
      ? tokenize(file.content, [["com", /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g], ["str", /(["'`])(?:\\.|(?!\1).)*\1/g], ["num", /\b(\d+\.?\d*)\b/g], ["kw", /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|new|this|async|await|try|catch|throw|true|false|null|undefined|def|print|fn|pub|use|struct|SELECT|FROM|WHERE)\b/g]])
      : escapeHtml(file.content);
    body.appendChild(code);
  }
  $("#preview-modal").hidden = false;
}

function closePreview() {
  $("#preview-modal").hidden = true;
  $("#preview-body").innerHTML = "";
}

async function deleteEntry(id) {
  const entry = state.entries.find((item) => item.id === id);
  if (!entry || !window.confirm(`Delete the ${entry.time} entry “${entry.title}”?`)) return;
  try {
    await api("DELETE", "/api/entries/" + encodeURIComponent(id));
    state.entries = state.entries.filter((item) => item.id !== id);
    applyFilter();
    renderWeek();
    renderContributionMap();
    renderDayView(entry.date);
  } catch (err) {
    alert("Delete failed: " + err.message);
  }
}

/* ── Entry detail (legacy) ─────────────── */

function renderEntryDetail(id) {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) {
    $("#detail-content").innerHTML = `<div class="empty"><div class="empty-title">Entry not found</div></div>`;
    return;
  }
  const sameDate = state.entries
    .filter((e) => e.date === entry.date)
    .sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  $("#detail-date").textContent = new Date(entry.date + "T00:00:00")
    .toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const totalChars = sameDate.reduce((s, e) => s + (e.body?.length || 0), 0);
  const allTags = new Set(sameDate.flatMap((e) => e.tags || []));
  const hours = sameDate.map((e) => { const [h, m] = e.time.split(":").map(Number); return h + m / 60; });
  const span = hours.length > 1 ? Math.max(...hours) - Math.min(...hours) : 0;
  const summaryHtml = `<div class="detail-summary">
    <div><b>${sameDate.length}</b> entries</div>
    <div><b>${totalChars.toLocaleString()}</b> chars</div>
    <div><b>${allTags.size}</b> tags</div>
    <div><b>${Math.round(span * 10) / 10}</b>h span</div>
  </div>`;
  const entriesHtml = sameDate.map((e, i) => {
    const fileHtml = e.files?.length
      ? `<div class="detail-files">${e.files.map((f) => {
          const name = typeof f === "string" ? f : f.name;
          return `<button class="file-card" type="button" data-file='${escapeHtml(JSON.stringify(f))}'><div class="file-icon">${fileIcon(name)}</div><div class="file-meta"><span class="file-name">${escapeHtml(name)}</span><span class="file-size">preview</span></div></button>`;
        }).join("")}</div>`
      : "";
    const tagHtml = e.tags?.length
      ? `<div class="detail-tags">${e.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>`
      : "";
    let dur = "";
    if (i < sameDate.length - 1) {
      const next = sameDate[i + 1];
      const [h1, m1] = e.time.split(":").map(Number);
      const [h2, m2] = next.time.split(":").map(Number);
      const mins = (h2 + m2 / 60) - (h1 + m1 / 60);
      if (mins > 0 && mins < 12) dur = `<span class="duration">+${Math.round(mins * 60)}m</span>`;
    }
    return `<div class="detail-entry">
      <div class="detail-entry-time">${escapeHtml(e.time)}${dur}</div>
      <div class="detail-entry-main">
        <h2 class="detail-entry-title">${escapeHtml(e.title)}</h2>
        <div class="detail-entry-body">${parseMarkdown(e.body)}</div>
        ${fileHtml}${tagHtml}
      </div>
    </div>`;
  }).join("");
  $("#detail-content").innerHTML = summaryHtml + entriesHtml;
  $$(".code-copy").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pre = btn.closest(".code-block").querySelector("pre");
      navigator.clipboard?.writeText(pre.innerText).then(() => {
        const orig = btn.textContent;
        btn.textContent = "copied";
        setTimeout(() => btn.textContent = orig, 1200);
      });
    });
  });
}

/* ── Modal ────────────────────────────── */

const modal = $("#modal");
const form = $("#entry-form");
const tokenModal = $("#token-modal");
const tokenForm = $("#token-form");
const ENTRY_TOKEN = "Iris27";

function requestNewEntry() {
  tokenForm.reset();
  tokenModal.hidden = false;
  setTimeout(() => $("#entry-token").focus(), 50);
}

function closeTokenModal() {
  tokenModal.hidden = true;
  tokenForm.reset();
}

function openModal(entry) {
  form.reset();
  form.dataset.existingFiles = JSON.stringify(entry?.files || []);
  $("#modal-title").textContent = entry ? "Edit entry" : "New entry";
  if (entry) {
    form.entryId.value = entry.id;
    form.date.value = entry.date;
    form.time.value = entry.time;
    form.title.value = entry.title;
    form.body.value = entry.body;
    form.tags.value = (entry.tags || []).join(", ");
    // Rebuild file previews for edit mode from entry files
    const preview = document.getElementById("file-preview");
    if (preview) {
      preview.innerHTML = "";
      (entry.files || []).forEach((f) => {
        const name = typeof f === "string" ? f : f.name || "file";
        const card = document.createElement("div");
        card.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--line);border-radius:2px;background:var(--bg-1);font-family:var(--mono);font-size:11px;color:var(--fg);flex:1;min-width:160px;";
        const icon = document.createElement("span");
        const ext = (name.split(".").pop() || "").toLowerCase();
        const iconChars = { img: "IMG", vid: "VID", aud: "AUD", pdf: "PDF", md: "MD", js: "JS", ts: "TS", py: "PY", rb: "RB", go: "GO", code: "CD", data: "DB", zip: "ZIP", file: "FILE" };
        icon.textContent = iconChars[ext] || "FILE";
        icon.style.cssText = "width:24px;height:24px;display:flex;align-items:center;justify-content:center;border:1px solid var(--line-2);font-size:9px;color:var(--dim);flex-shrink:0;";
        const meta = document.createElement("div");
        meta.style.cssText = "display:flex;flex-direction:column;min-width:0;";
        meta.innerHTML = `<span style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">` + escapeHtml(name) + `</span>`;
        card.append(icon, meta);
        preview.appendChild(card);
      });
    }
  } else {
    form.date.value = state.filterDate || today();
    form.time.value = nowTime();
    // Reset file input
    const fileInputEl = document.getElementById("file-input");
    if (fileInputEl) fileInputEl.value = "";
    const preview = document.getElementById("file-preview");
    if (preview) preview.innerHTML = "";
  }
  modal.hidden = false;
  setTimeout(() => form.title.focus(), 50);
}

function closeModal() {
  modal.hidden = true;
  form.reset();
  delete form.dataset.entryToken;
  delete form.dataset.existingFiles;
}

function wireEvents() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeModal();
    if (e.key === "Escape" && !tokenModal.hidden) closeTokenModal();
    if (e.key === "Escape" && !$("#preview-modal").hidden) closePreview();
    if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); requestNewEntry(); }
    if (e.key === "Escape" && (parseHash().view === "day" || parseHash().view === "entry")) navigate("#/");
  });

  $("#new-btn").addEventListener("click", requestNewEntry);
  document.querySelector(".brand-btn")?.addEventListener("click", () => navigate("#/"));
  $$(".nav-btn").forEach((b) => b.addEventListener("click", () => navigate(b.dataset.view === "home" ? "#/" : "#/calendar")));
  $("#day-back")?.addEventListener("click", () => navigate("#/"));
  $("#detail-back")?.addEventListener("click", () => navigate("#/"));

  $("#cal-prev")?.addEventListener("click", () => shiftMonth(-1));
  $("#cal-next")?.addEventListener("click", () => shiftMonth(1));
  $("#cal-grid")?.addEventListener("click", (e) => {
    const cell = e.target.closest(".cal-cell");
    if (!cell) return;
    navigate("#/day/" + cell.dataset.date);
  });

  modal?.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  tokenModal?.addEventListener("click", (e) => { if (e.target === tokenModal) closeTokenModal(); });
  $("#modal-close")?.addEventListener("click", closeModal);
  $("#modal-cancel")?.addEventListener("click", closeModal);
  $("#token-modal-close")?.addEventListener("click", closeTokenModal);
  $("#token-modal-cancel")?.addEventListener("click", closeTokenModal);
  $("#preview-close")?.addEventListener("click", closePreview);
  $("#preview-modal")?.addEventListener("click", (e) => { if (e.target.id === "preview-modal") closePreview(); });

  tokenForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    if (tokenForm.token.value !== ENTRY_TOKEN) {
      alert("Invalid token.");
      tokenForm.token.select();
      return;
    }
    form.dataset.entryToken = tokenForm.token.value;
    closeTokenModal();
    openModal();
  });

  $("#entry-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    // Read selected files
    const fileInputEl = document.getElementById("file-input");
    const fileList = Array.from(fileInputEl ? (fileInputEl.files ? fileInputEl.files : []) : []);
    const uploadedFiles = await Promise.all(fileList.map(readAttachment));
    const existingFiles = JSON.parse(form.dataset.existingFiles || "[]");
    const data = {
      date: form.date.value,
      time: form.time.value,
      title: form.title.value.trim(),
      body: form.body.value,
      tags: form.tags.value.split(",").map((s) => s.trim()).filter(Boolean),
      files: uploadedFiles.length ? uploadedFiles : existingFiles,
      token: form.dataset.entryToken,
    };
    try {
      const entryId = form.entryId?.value;
      if (entryId) {
        await api("PUT", "/api/entries/" + entryId, data);
      } else {
        await api("POST", "/api/entries", data);
      }
      closeModal();
      await refresh();
    } catch (err) {
      alert("Save failed: " + err.message);
    }
  });

  $("#day-entries")?.addEventListener("click", (e) => {
    const file = e.target.closest("[data-file]");
    if (file) {
      e.stopPropagation();
      openAttachment(file.dataset.file);
      return;
    }
    const edit = e.target.closest("[data-edit-entry]");
    if (edit) {
      e.stopPropagation();
      const entry = state.entries.find((item) => item.id === edit.dataset.editEntry);
      if (entry) openModal(entry);
      return;
    }
    const remove = e.target.closest("[data-delete-entry]");
    if (remove) {
      e.stopPropagation();
      deleteEntry(remove.dataset.deleteEntry);
    }
  });
  $("#detail-content")?.addEventListener("click", (e) => {
    const file = e.target.closest("[data-file]");
    if (file) openAttachment(file.dataset.file);
  });

  // Timeline: clicking a day card navigates to day view
  $("#timeline")?.addEventListener("click", (e) => {
    const card = e.target.closest(".day-card");
    if (!card) return;
    navigate("#/day/" + card.dataset.date);
  });
}

function renderStats(score) {
  if (!score) {
    $("#score-num").textContent = "0";
    $("#score-reason").textContent = "No entries today.";
    $("#stat-count").textContent = "0";
    $("#stat-tags").textContent = "0";
    $("#stat-span").textContent = "0";
    return;
  }
  $("#score-num").textContent = score.score;
  $("#score-reason").textContent = score.reason;
  $("#stat-count").textContent = score.count;
  $("#stat-tags").textContent = score.tags;
  $("#stat-span").textContent = score.span;
}

async function refresh() {
  try {
    const [entries, score] = await Promise.all([api("GET", "/api/entries"), api("GET", "/api/score")]);
    state.entries = entries;
    state.score = score;
    renderStats(score);
    applyFilter();
    renderWeek();
    renderContributionMap();
    const route = parseHash();
    if (route.view === "calendar") renderCalendar();
    if (route.view === "day") renderDayView(route.date);
    if (route.view === "entry") {
      const id = route.id;
      if (id && entries.find((e) => e.id === id)) renderEntryDetail(id);
    }
  } catch (e) {
    console.error(e);
  }
}

function readAttachment(file) {
  return new Promise((resolve) => {
    const image = file.type.startsWith("image/");
    const reader = new FileReader();
    reader.onload = () => resolve({
      name: file.name,
      type: file.type || "text/plain",
      size: file.size,
      content: String(reader.result || ""),
      encoding: image ? "data-url" : "text",
    });
    reader.onerror = () => resolve({ name: file.name, type: file.type || "application/octet-stream", size: file.size, content: "", encoding: "text" });
    if (image) reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

function handleFiles(input) {
  const preview = document.getElementById("file-preview");
  if (!preview) return;
  preview.innerHTML = "";
  for (const file of Array.from(input.files || [])) {
    const card = document.createElement("div");
    card.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--line);border-radius:2px;background:var(--bg-1);font-family:var(--mono);font-size:11px;color:var(--fg);flex:1;min-width:160px;";
    const icon = document.createElement("span");
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const iconChars = { img: "IMG", vid: "VID", aud: "AUD", pdf: "PDF", md: "MD", js: "JS", ts: "TS", py: "PY", rb: "RB", go: "GO", code: "CD", data: "DB", zip: "ZIP", file: "FILE" };
    icon.textContent = iconChars[ext] || "FILE";
    icon.style.cssText = "width:24px;height:24px;display:flex;align-items:center;justify-content:center;border:1px solid var(--line-2);font-size:9px;color:var(--dim);flex-shrink:0;";
    const meta = document.createElement("div");
    meta.style.cssText = "display:flex;flex-direction:column;min-width:0;";
    meta.innerHTML = `<span style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">` + escapeHtml(file.name) + `</span><span style="font-size:9px;color:var(--mute);margin-top:2px;">` + ((file.size / 1024).toFixed(1)) + ` KB · ` + (file.type || "unknown") + `</span>`;
    card.append(icon, meta);
    preview.appendChild(card);
    if (file.type && file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const thumb = document.createElement("img");
        thumb.src = e.target.result;
        thumb.style.cssText = "width:44px;height:44px;object-fit:cover;border-radius:2px;border:1px solid var(--line);margin-top:6px;";
        card.appendChild(thumb);
      };
      reader.readAsDataURL(file);
    }
    if (file.type && (file.type.startsWith("text/") || file.name.endsWith(".md") || file.name.endsWith(".txt") || file.name.endsWith(".js") || file.name.endsWith(".ts"))) {
      const reader2 = new FileReader();
      reader2.onload = (e2) => {
        const snippet = (e2.target.result || "").toString().slice(0, 180);
        meta.innerHTML += `<span style="font-size:10px;color:var(--mute);margin-top:4px;">` + escapeHtml(snippet) + (snippet.length >= 180 ? "..." : "") + `</span>`;
      };
      reader2.readAsText(file);
    }
  }
}

(async () => {
  const now = new Date();
  state.calYear = now.getFullYear();
  state.calMonth = now.getMonth();
  wireEvents();
  try {
    const status = await api("GET", "/api/status");
    state.mode = status.mode;
    if (status.mode === "drive" && !status.hasTokens) {
      const banner = document.createElement("div");
      banner.className = "auth-banner";
      banner.innerHTML = `<span>Google Drive not authorized.</span><a href="/auth/start">Authorize →</a>`;
      document.body.prepend(banner);
    }
  } catch (e) { /* ignore */ }
  await refresh();
  handleRoute();
})();
