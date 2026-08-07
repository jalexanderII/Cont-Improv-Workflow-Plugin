/**
 * The live dashboard document, served by view-server.ts.
 *
 * Kept in its own module because it's a self-contained document rather than
 * server logic. No backticks or template placeholders in here: the whole thing
 * is a String.raw literal.
 */

export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="color-scheme" content="dark" />
<title>Workflow run</title>
<style>
  :root {
    --bg: #0d0d0f;
    --surface: #141417;
    --surface-hi: #1a1a1e;
    --line: #26262c;
    --line-soft: #1e1e23;
    --fg: #e8e8ec;
    --fg-2: #a0a0aa;
    --fg-3: #6e6e78;
    --accent: #6ea8fe;
    --ok: #4ec9a0;
    --warn: #d9a441;
    --err: #e06c6c;
    --info: #6ca7d9;
  }

  * { box-sizing: border-box; }

  html, body { height: 100%; }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 13px/1.55 ui-sans-serif, -apple-system, "SF Pro Text", system-ui, sans-serif;
    font-variant-numeric: tabular-nums;
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }

  /* ---------- header ---------- */

  header {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--bg);
    border-bottom: 1px solid var(--line);
    padding: 18px 28px 0;
  }

  .title-row {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }

  h1 {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .runid {
    font-size: 12px;
    color: var(--fg-3);
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 9px 2px 7px;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.02em;
    color: var(--fg-2);
    text-transform: capitalize;
  }

  .status .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--fg-3);
  }

  .status[data-state="running"] { color: var(--warn); border-color: #3a3020; }
  .status[data-state="running"] .dot {
    background: var(--warn);
    animation: pulse 1.6s ease-in-out infinite;
  }
  .status[data-state="finished"] { color: var(--ok); border-color: #1f3a31; }
  .status[data-state="finished"] .dot { background: var(--ok); }
  .status[data-state="error"], .status[data-state="stopped"] {
    color: var(--err); border-color: #3d2626;
  }
  .status[data-state="error"] .dot, .status[data-state="stopped"] .dot {
    background: var(--err);
  }

  @keyframes pulse { 50% { opacity: 0.25; } }

  .meta {
    display: flex;
    gap: 20px;
    flex-wrap: wrap;
    margin: 10px 0 0;
    font-size: 12px;
    color: var(--fg-3);
  }

  .meta b {
    font-weight: 500;
    color: var(--fg-2);
  }

  .meta .path {
    max-width: 46ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---------- progress ---------- */

  .progress {
    margin: 14px -28px 0;
    height: 3px;
    background: var(--line);
    position: relative;
  }

  .progress i {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--accent);
    transition: width 0.4s ease;
  }

  /* ---------- stats ---------- */

  .stats {
    display: flex;
    gap: 0;
    padding: 0 28px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }

  .stat {
    padding: 16px 28px 16px 0;
    margin-right: 28px;
    min-width: 92px;
    border-right: 1px solid var(--line-soft);
  }

  .stat:last-child { border-right: 0; }

  .stat .k {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--fg-3);
  }

  .stat .v {
    margin-top: 3px;
    font-size: 21px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.15;
  }

  .stat .v.muted { color: var(--fg-3); }
  .stat .v.ok { color: var(--ok); }
  .stat .v.warn { color: var(--warn); }
  .stat .v.info { color: var(--info); }
  .stat .v.err { color: var(--err); }

  /* ---------- phases ---------- */

  main { padding: 8px 28px 56px; }

  .phase { margin-top: 26px; }

  .phase-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-bottom: 8px;
  }

  .phase-head .spacer { flex: 1; }

  .phase-name {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .phase-sub {
    font-size: 12px;
    color: var(--fg-3);
  }

  /* Fixed width: stretched across the row it reads as a divider rule, not
     as progress. */
  .bar {
    width: 120px;
    height: 3px;
    background: var(--line);
    border-radius: 2px;
    position: relative;
    overflow: hidden;
  }

  .bar i {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--ok);
    border-radius: 1px;
    transition: width 0.4s ease;
  }

  /* ---------- table ---------- */

  table {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow: hidden;
    table-layout: fixed;
  }

  th {
    background: var(--surface);
    text-align: left;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--fg-3);
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
  }

  td {
    padding: 7px 12px;
    border-bottom: 1px solid var(--line-soft);
    vertical-align: top;
  }

  tr:last-child td { border-bottom: 0; }
  tbody tr:hover td { background: var(--surface-hi); }

  .c-id    { width: 52px;  text-align: right; color: var(--fg-3); }
  .c-state { width: 104px; }
  .c-time  { width: 78px;  text-align: right; color: var(--fg-2); }
  .c-tok   { width: 92px;  text-align: right; color: var(--fg-2); }

  td.name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--fg-2);
  }

  .state::before {
    content: "";
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    flex: none;
  }

  .state.running  { color: var(--warn); }
  .state.finished { color: var(--ok); }
  .state.cached   { color: var(--info); }
  .state.error, .state.cancelled { color: var(--err); }
  .state.pending  { color: var(--fg-3); }
  .state.running::before { animation: pulse 1.6s ease-in-out infinite; }

  tr.is-pending td { color: var(--fg-3); }

  .err-msg {
    margin-top: 3px;
    color: var(--err);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .empty {
    padding: 60px 0;
    text-align: center;
    color: var(--fg-3);
  }

  footer {
    padding: 0 28px 32px;
    color: var(--fg-3);
    font-size: 11px;
  }
</style>
</head>
<body>
<header>
  <div class="title-row">
    <h1 id="wf">&nbsp;</h1>
    <span class="status" id="status"><span class="dot"></span><span id="status-text"></span></span>
    <span class="runid mono" id="runid"></span>
  </div>
  <div class="meta" id="meta"></div>
  <div class="progress"><i id="progress-bar" style="width:0%"></i></div>
</header>

<div class="stats" id="stats"></div>
<main id="phases"><div class="empty">Waiting for the first agent...</div></main>
<footer id="footer"></footer>

<script>
var POLL_MS = 1000;
var lastGood = null;

function tokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function duration(ms) {
  var s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

function agentTime(a) {
  if (!a.startedAt) return "";
  return duration((a.endedAt || Date.now()) - a.startedAt);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}

// Trims to the last couple of segments. CSS ellipsis alone would cut off the
// end, which is the part that identifies the workspace.
function shortPath(p) {
  var parts = String(p).split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return ".../" + parts.slice(-2).join("/");
}

function stat(label, value, cls) {
  return '<div class="stat"><div class="k">' + label +
    '</div><div class="v ' + (cls || "") + '">' + value + "</div></div>";
}

function render(s) {
  var t = s.totals;
  var settled = t.finished + t.cached + t.errored;
  var pct = t.agents > 0 ? Math.round((settled / t.agents) * 100) : 0;
  var live = s.status === "running";

  document.title = s.workflow + " — " + (live ? pct + "%" : s.status);

  document.getElementById("wf").textContent = s.workflow;
  document.getElementById("runid").textContent = s.runId;
  document.getElementById("status").setAttribute("data-state", s.status);
  document.getElementById("status-text").textContent = s.status;

  document.getElementById("meta").innerHTML =
    "<span>Elapsed <b>" + duration((s.endedAt || Date.now()) - s.startedAt) + "</b></span>" +
    "<span>Progress <b>" + settled + " / " + t.agents + "</b></span>" +
    "<span>Concurrency <b>" + s.concurrency + "</b></span>" +
    '<span class="path" title="' + esc(s.cwd) + '">' + esc(shortPath(s.cwd)) + "</span>";

  document.getElementById("progress-bar").style.width = pct + "%";

  document.getElementById("stats").innerHTML =
    stat("Agents", t.agents) +
    stat("Running", t.running, t.running > 0 ? "warn" : "muted") +
    stat("Completed", t.finished, t.finished > 0 ? "ok" : "muted") +
    stat("Cached", t.cached, t.cached > 0 ? "info" : "muted") +
    stat("Failed", t.errored, t.errored > 0 ? "err" : "muted") +
    stat("Tokens", tokens(t.tokens));

  if (s.agents.length === 0) {
    document.getElementById("phases").innerHTML =
      '<div class="empty">Waiting for the first agent...</div>';
  } else {
    var groups = [];
    var index = {};
    s.agents.forEach(function (a) {
      if (index[a.phase] === undefined) {
        index[a.phase] = groups.length;
        groups.push({ name: a.phase, agents: [] });
      }
      groups[index[a.phase]].agents.push(a);
    });

    var html = "";
    groups.forEach(function (g) {
      var tok = 0;
      var done = 0;
      g.agents.forEach(function (a) {
        tok += a.tokens;
        if (a.status !== "running" && a.status !== "pending") done += 1;
      });
      var gpct = Math.round((done / g.agents.length) * 100);

      html +=
        '<section class="phase"><div class="phase-head">' +
        '<span class="phase-name">' + esc(g.name) + "</span>" +
        '<span class="phase-sub">' + done + " / " + g.agents.length +
        " agents · " + tokens(tok) + " tokens</span>" +
        '<span class="spacer"></span>' +
        '<span class="bar" title="' + gpct + '% complete"><i style="width:' +
        gpct + '%"></i></span>' +
        "</div><table><colgroup>" +
        '<col class="c-id"><col class="c-state"><col><col class="c-time"><col class="c-tok">' +
        "</colgroup><thead><tr>" +
        '<th class="c-id">#</th><th class="c-state">Status</th><th>Agent</th>' +
        '<th class="c-time">Time</th><th class="c-tok">Tokens</th>' +
        "</tr></thead><tbody>";

      g.agents.forEach(function (a) {
        html +=
          '<tr class="' + (a.status === "pending" ? "is-pending" : "") + '">' +
          '<td class="c-id mono">' + a.id + "</td>" +
          '<td class="c-state"><span class="state ' + a.status + '">' + a.status + "</span></td>" +
          '<td class="name" title="' + esc(a.label) + '">' + esc(a.label) +
          (a.error ? '<div class="err-msg">' + esc(a.error) + "</div>" : "") +
          "</td>" +
          '<td class="c-time mono">' + agentTime(a) + "</td>" +
          '<td class="c-tok mono">' + tokens(a.tokens) + "</td>" +
          "</tr>";
      });

      html += "</tbody></table></section>";
    });

    document.getElementById("phases").innerHTML = html;
  }

  document.getElementById("footer").textContent = live
    ? "Updating every second."
    : "Run " + s.status + " — this is the final state. The server exits shortly; " +
      "the canvas has the full report.";
}

function tick() {
  fetch("/state", { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (s) {
      lastGood = s;
      render(s);
      if (s.status !== "running") clearInterval(timer);
    })
    .catch(function () {
      clearInterval(timer);
      if (lastGood !== null) {
        // Keep the last frame rather than blanking the page, but be explicit
        // that it may predate the end of the run.
        document.getElementById("footer").textContent =
          "Disconnected — this server exits with the run. The frame above may " +
          "predate the finish. Check 'wf show' or the canvas for the final state.";
        return;
      }
      // Never connected: almost always a finished run whose server is gone.
      document.getElementById("phases").innerHTML =
        '<div class="empty">This run\'s dashboard is no longer live.<br><br>' +
        "The server only runs alongside the workflow. Use <b>wf list</b> to find " +
        "the run, <b>wf show &lt;runId&gt;</b> for its final state, or open its " +
        "canvas for the full report.</div>";
      document.getElementById("footer").textContent = "Not connected.";
    });
}

var timer = setInterval(tick, POLL_MS);
tick();
</script>
</body>
</html>`;
