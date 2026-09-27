const express = require("express");
const app = express();
const PORT = process.env.PORT || 10000;
const KEY = process.env.AITUBER_API_KEY;
const BASE = "https://app.aituber.app/api/v1";

app.use(express.json({ limit: "1mb" }));

const jobs = [];
let seq = 1;
let running = false;

async function api(path, opt = {}) {
  if (!KEY) throw Error("AITUBER_API_KEY is missing in Render.");

  const r = await fetch(BASE + path, {
    ...opt,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(opt.headers || {})
    }
  });

  const t = await r.text();
  let d;
  try {
    d = t ? JSON.parse(t) : {};
  } catch {
    d = { raw: t };
  }

  if (!r.ok) {
    const e = Error(d?.message || d?.error || `AITuber HTTP ${r.status}`);
    e.status = r.status;
    e.data = d;
    throw e;
  }

  return d;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

function pub(j) {
  return { ...j };
}

function addJob(x) {
  const now = new Date().toISOString();
  const j = {
    id: seq++,
    niche: x.niche || "General",
    idea: x.idea,
    duration: +x.duration || 45,
    aspectRatio: x.aspectRatio || "9:16",
    status: "queued",
    aituberVideoId: null,
    exportStatus: null,
    downloadUrl: null,
    error: null,
    createdAt: now,
    updatedAt: now
  };

  jobs.push(j);
  worker();
  return j;
}

async function worker() {
  if (running) return;
  running = true;

  try {
    for (;;) {
      const j = jobs.find(x => x.status === "queued");
      if (!j) break;

      j.status = "generating";
      j.updatedAt = new Date().toISOString();

      try {
        const g = await api("/videos/generate", {
          method: "POST",
          body: JSON.stringify({
            script: j.idea,
            inputType: "idea",
            expectedDurationSeconds: j.duration,
            aspectRatio: j.aspectRatio
          })
        });

        j.aituberVideoId = g.videoId || g.id;
        if (!j.aituberVideoId) throw Error("AITuber did not return a videoId.");

        j.status = "processing";

        let done = false;
        for (let i = 0; i < 40; i++) {
          await wait(15000);
          const s = await api("/videos/" + encodeURIComponent(j.aituberVideoId));
          const d = s?.data || s;

          j.status = d.status || "processing";
          j.updatedAt = new Date().toISOString();

          if (d.status === "failed") {
            throw Error(d.error || d.message || "AITuber generation failed.");
          }
          if (d.status === "completed") {
            done = true;
            break;
          }
        }

        if (!done) throw Error("Generation is still processing. Refresh AITuber later.");

        const ex = await api("/exports", {
          method: "POST",
          body: JSON.stringify({ videoId: j.aituberVideoId })
        });

        j.exportStatus = ex?.exportStatus || ex?.status || "processing";
        j.status = "exporting";

        for (let i = 0; i < 24; i++) {
          await wait(15000);
          const s = await api("/videos/" + encodeURIComponent(j.aituberVideoId));
          const d = s?.data || s;

          j.exportStatus = d.exportStatus || j.exportStatus;
          j.updatedAt = new Date().toISOString();

          if (d.exportStatus === "completed") {
            const q = await api("/exports/download?videoId=" + encodeURIComponent(j.aituberVideoId));
            j.downloadUrl = q.downloadUrl || q.url || q.signedUrl || q.download_url || null;
            j.status = j.downloadUrl ? "completed" : "exported";
            break;
          }

          if (d.exportStatus === "failed") {
            throw Error("AITuber export failed.");
          }
        }
      } catch (e) {
        j.status = "failed";
        j.error = e.message;
        j.updatedAt = new Date().toISOString();
        console.error(e);
      }
    }
  } finally {
    running = false;
  }
}

app.get("/health", (req, res) =>
  res.json({
    ok: true,
    service: "AITuber Content Autopilot V2",
    aituberKeyConfigured: !!KEY,
    queueSize: jobs.length,
    workerRunning: running,
    time: new Date().toISOString()
  })
);

app.get("/api/jobs", (req, res) => {
  res.json({ jobs: jobs.slice().reverse().map(pub) });
});

app.post("/api/jobs", (req, res) => {
  const { niche, idea, duration, aspectRatio } = req.body || {};

  if (!idea || typeof idea !== "string") {
    return res.status(400).json({ error: "idea is required" });
  }

  if (idea.length > 10000) {
    return res.status(400).json({ error: "idea/script is limited to 10,000 characters" });
  }

  const job = addJob({
    niche,
    idea: idea.trim(),
    duration,
    aspectRatio
  });

  return res.status(202).json(pub(job));
});

app.post("/api/jobs/:id/retry", (req, res) => {
  const j = jobs.find(x => x.id === +req.params.id);

  if (!j) {
    return res.status(404).json({ error: "Job not found" });
  }

  j.status = "queued";
  j.error = null;
  j.downloadUrl = null;
  j.updatedAt = new Date().toISOString();

  worker();

  return res.json(pub(j));
});

app.get("/", (req, res) =>
  res.type("html").send(`<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Content Autopilot V2</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #080d19;
    color: #f5f7ff;
    font-family: system-ui, sans-serif;
    padding: 18px;
  }
  .wrap { max-width: 1050px; margin: auto; }
  .card {
    background: #121a2b;
    border: 1px solid #263451;
    border-radius: 18px;
    padding: 18px;
    margin-bottom: 15px;
  }
  .grid {
    display: grid;
    grid-template-columns: 1.2fr .8fr;
    gap: 15px;
  }
  label { display: block; margin: 12px 0 6px; color: #cfd8ea; }
  textarea, input, select, button {
    width: 100%;
    padding: 12px;
    border-radius: 11px;
    border: 1px solid #354361;
    background: #0c1322;
    color: #fff;
    font-size: 15px;
  }
  textarea { min-height: 120px; }
  button {
    margin-top: 13px;
    background: #6658e8;
    border: 0;
    font-weight: 700;
    cursor: pointer;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
  }
  .stat {
    background: #0d1424;
    border-radius: 12px;
    padding: 13px;
  }
  .num {
    font-size: 24px;
    font-weight: 800;
  }
  .job {
    border: 1px solid #2a3855;
    background: #0d1424;
    border-radius: 14px;
    padding: 14px;
    margin-top: 10px;
  }
  .top {
    display: flex;
    justify-content: space-between;
    gap: 10px;
  }
  .pill {
    padding: 5px 9px;
    border-radius: 99px;
    background: #263451;
    font-size: 12px;
  }
  a { color: #9db7ff; }
  .muted { color: #9aa8c2; }
  @media (max-width: 750px) {
    .grid { grid-template-columns: 1fr; }
    .stats { grid-template-columns: repeat(2, 1fr); }
  }
</style>

<div class="wrap">
  <div class="card">
    <h1>🤖 AI Content Autopilot V2</h1>
    <p class="muted">Content queue + AITuber generation + MP4 export</p>
  </div>

  <div class="stats">
    <div class="stat">
      Total
      <div id="total" class="num">0</div>
    </div>
    <div class="stat">
      Queued
      <div id="queued" class="num">0</div>
    </div>
    <div class="stat">
      Processing
      <div id="processing" class="num">0</div>
    </div>
    <div class="stat">
      Completed
      <div id="completed" class="num">0</div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>➕ Add Video</h2>
      <label>Niche</label>
      <input id="niche" placeholder="AI tools, motivation, Kenya facts">

      <label>Video idea</label>
      <textarea id="idea" placeholder="5 AI tools that can help a small business save time"></textarea>

      <label>Duration</label>
      <select id="duration">
        <option>30</option>
        <option selected>45</option>
        <option>60</option>
      </select>

      <label>Format</label>
      <select id="ratio">
        <option selected>9:16</option>
        <option>16:9</option>
        <option>1:1</option>
      </select>

      <button onclick="add()">🚀 Add to Queue</button>
    </div>

    <div class="card">
      <h2>⚙️ Engine</h2>
      <p class="muted">One AITuber job is processed at a time in V2.</p>
      <button onclick="load()">🔄 Refresh Queue</button>
      <button onclick="health()">💓 Check Server</button>
      <p id="health" class="muted"></p>
    </div>
  </div>

  <div class="card">
    <h2>🎞️ Content Queue</h2>
    <div id="jobs">Loading...</div>
  </div>
</div>

<script>
  const esc = s => String(s).replace(/[&<>\"']/g, m => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[m]));

  async function add() {
    const idea = document.getElementById("idea").value.trim();
    if (!idea) return alert("Enter a video idea.");

    const r = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        niche: document.getElementById("niche").value.trim() || "General",
        idea,
        duration: +document.getElementById("duration").value,
        aspectRatio: document.getElementById("ratio").value
      })
    });

    const d = await r.json();
    if (!r.ok) return alert(d.error || "Failed");

    document.getElementById("idea").value = "";
    load();
  }

  async function retry(id) {
    await fetch("/api/jobs/" + id + "/retry", { method: "POST" });
    load();
  }

  async function load() {
    const d = await (await fetch("/api/jobs")).json();
    const a = d.jobs || [];

    total.textContent = a.length;
    queued.textContent = a.filter(x => x.status === "queued").length;
    processing.textContent = a.filter(x => ["generating", "processing", "exporting"].includes(x.status)).length;
    completed.textContent = a.filter(x => ["completed", "exported"].includes(x.status)).length;

    jobs.innerHTML = a.length
      ? a.map(j => `
        <div class="job">
          <div class="top">
            <strong>#${j.id} · ${esc(j.niche)}</strong>
            <span class="pill">${esc(j.status)}</span>
          </div>
          <p>${esc(j.idea)}</p>
          <div class="muted">${j.duration}s · ${j.aspectRatio} · ${j.aituberVideoId || "waiting"}</div>
          ${j.downloadUrl ? `<p><a href="${j.downloadUrl}" target="_blank">🎥 Open MP4</a></p>` : ""}
          ${j.status === "failed" ? `<button onclick="retry(${j.id})">↻ Retry</button>` : ""}
          ${j.error ? `<p style="color:#ff9696">${esc(j.error)}</p>` : ""}
        </div>
      `).join("")
      : "<p class='muted'>No videos in queue yet.</p>";
  }

  async function health() {
    const d = await (await fetch("/health")).json();
    document.getElementById("health").textContent =
      `Server: ${d.ok ? "ONLINE" : "OFFLINE"} · AITuber key: ${d.aituberKeyConfigured ? "configured" : "missing"}`;
  }

  load();
  health();
  setInterval(load, 10000);
</script>`));

app.listen(PORT, () => console.log("AITuber V2 running on " + PORT));
