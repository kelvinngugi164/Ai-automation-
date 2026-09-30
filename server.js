const express = require("express");

const app = express();
const PORT = process.env.PORT || 8080;

const AITUBER_API_KEY = process.env.AITUBER_API_KEY;
const AITUBER_BASE = "https://app.aituber.app/api/v1";

app.use(express.json({ limit: "1mb" }));

const jobs = new Map();
let syncRunning = false;

function requireKey(res) {
  if (!AITUBER_API_KEY) {
    res.status(500).json({
      error: "AITUBER_API_KEY is not configured on Render."
    });
    return false;
  }
  return true;
}

async function aituber(path, options = {}) {
  if (!AITUBER_API_KEY) {
    throw new Error("AITUBER_API_KEY is missing.");
  }

  const response = await fetch(`${AITUBER_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${AITUBER_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error ||
      data?.detail ||
      `AITuber API returned HTTP ${response.status}`;

    const err = new Error(message);
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeVideo(item) {
  const v = item?.video || item;

  return {
    id: v?.id || v?.videoId || item?.id || item?.videoId || null,
    title: v?.title || v?.name || v?.script || item?.title || "Untitled video",
    status: v?.status || item?.status || "unknown",
    exportStatus:
      v?.exportStatus ||
      item?.exportStatus ||
      null,
    createdAt:
      v?.createdAt ||
      v?.created_at ||
      item?.createdAt ||
      item?.created_at ||
      null,
    duration:
      v?.duration ||
      v?.expectedDurationSeconds ||
      item?.duration ||
      null,
    aspectRatio:
      v?.aspectRatio ||
      item?.aspectRatio ||
      null,
    raw: v
  };
}

function extractVideoArray(data) {
  if (Array.isArray(data)) return data;

  const candidates = [
    data?.videos,
    data?.items,
    data?.data,
    data?.results
  ];

  for (const value of candidates) {
    if (Array.isArray(value)) return value;
  }

  return [];
}

function extractVideoId(data) {
  return (
    data?.videoId ||
    data?.id ||
    data?.video?.id ||
    data?.video?.videoId ||
    null
  );
}

function extractSignedDownloadUrl(data) {
  return (
    data?.downloadUrl ||
    data?.url ||
    data?.signedUrl ||
    data?.download_url ||
    data?.data?.downloadUrl ||
    data?.data?.url ||
    data?.data?.signedUrl ||
    null
  );
}

async function listVideos() {
  const data = await aituber("/videos");
  return extractVideoArray(data).map(normalizeVideo);
}

async function getVideo(videoId) {
  const data = await aituber(`/videos/${encodeURIComponent(videoId)}`);
  return normalizeVideo(data);
}

async function requestExport(videoId) {
  return aituber("/exports", {
    method: "POST",
    body: JSON.stringify({ videoId })
  });
}

async function getDownloadUrl(videoId) {
  const data = await aituber(
    `/exports/download?videoId=${encodeURIComponent(videoId)}`
  );
  return extractSignedDownloadUrl(data);
}

async function exportExistingVideo(videoId) {
  const jobId = `export-${videoId}`;

  if (jobs.has(jobId)) {
    return jobs.get(jobId);
  }

  const job = {
    id: jobId,
    videoId,
    type: "existing-video-export",
    status: "export_requested",
    exportStatus: null,
    downloadUrl: null,
    error: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  jobs.set(jobId, job);

  (async () => {
    try {
      const current = await getVideo(videoId);

      if (current.status !== "completed") {
        throw new Error(
          `Video is not ready for export. Current video status: ${current.status}`
        );
      }

      job.status = "export_requested";
      job.updatedAt = new Date().toISOString();

      try {
        await requestExport(videoId);
      } catch (err) {
        // If the video was already exported, AITuber may reject a duplicate
        // export request. We continue polling the video status below.
        const message = String(err.message || "").toLowerCase();

        if (
          !message.includes("already") &&
          !message.includes("export") &&
          !message.includes("completed")
        ) {
          throw err;
        }
      }

      job.status = "exporting";
      job.updatedAt = new Date().toISOString();

      // AITuber documents export rendering as usually 30 seconds to 5 minutes.
      for (let i = 0; i < 24; i++) {
        await sleep(15000);

        const latest = await getVideo(videoId);
        job.exportStatus = latest.exportStatus;
        job.updatedAt = new Date().toISOString();

        if (latest.exportStatus === "completed") {
          const url = await getDownloadUrl(videoId);

          job.status = "exported";
          job.downloadUrl = url;
          job.completedAt = new Date().toISOString();
          job.updatedAt = new Date().toISOString();
          return;
        }

        if (
          latest.exportStatus === "failed" ||
          latest.exportStatus === "error"
        ) {
          throw new Error(
            `AITuber export failed with exportStatus=${latest.exportStatus}`
          );
        }
      }

      throw new Error("Export did not finish within the 6-minute polling window.");
    } catch (err) {
      job.status = "failed";
      job.error = err.message || String(err);
      job.updatedAt = new Date().toISOString();
    }
  })();

  return job;
}

async function syncExistingVideos() {
  if (syncRunning) {
    return { started: false, message: "A sync is already running." };
  }

  syncRunning = true;

  try {
    const videos = await listVideos();

    const results = [];

    for (const video of videos) {
      if (!video.id) continue;

      if (video.status !== "completed") {
        results.push({
          videoId: video.id,
          status: "skipped",
          reason: `video status is ${video.status}`
        });
        continue;
      }

      const job = await exportExistingVideo(video.id);
      results.push({
        videoId: video.id,
        status: job.status
      });
    }

    return {
      started: true,
      totalVideos: videos.length,
      results
    };
  } finally {
    syncRunning = false;
  }
}

// -----------------------------
// API
// -----------------------------

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AITuber Content Autopilot V3 - Existing Videos",
    time: new Date().toISOString(),
    aituberKeyConfigured: Boolean(AITUBER_API_KEY)
  });
});

app.get("/api/videos", async (req, res) => {
  if (!requireKey(res)) return;

  try {
    const videos = await listVideos();
    res.json({ videos });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message,
      details: err.data || null
    });
  }
});

app.get("/api/video/:videoId", async (req, res) => {
  if (!requireKey(res)) return;

  try {
    const video = await getVideo(req.params.videoId);
    res.json({ video });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message,
      details: err.data || null
    });
  }
});

app.post("/api/export/:videoId", async (req, res) => {
  if (!requireKey(res)) return;

  try {
    const job = await exportExistingVideo(req.params.videoId);
    res.json({ job });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message,
      details: err.data || null
    });
  }
});

app.post("/api/sync", async (req, res) => {
  if (!requireKey(res)) return;

  try {
    const result = await syncExistingVideos();
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message,
      details: err.data || null
    });
  }
});

app.get("/api/jobs", (req, res) => {
  res.json({
    jobs: Array.from(jobs.values()).sort(
      (a, b) =>
        new Date(b.startedAt || 0) - new Date(a.startedAt || 0)
    )
  });
});

app.post("/api/jobs/:jobId/retry", async (req, res) => {
  const old = jobs.get(req.params.jobId);

  if (!old || !old.videoId) {
    return res.status(404).json({ error: "Export job not found." });
  }

  jobs.delete(req.params.jobId);

  try {
    const job = await exportExistingVideo(old.videoId);
    res.json({ job });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Channel discovery is read-only and does not spend generation credits.
app.get("/api/channels", async (req, res) => {
  if (!requireKey(res)) return;

  try {
    const data = await aituber("/channels");
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message,
      details: err.data || null
    });
  }
});

// Generic publication proxy.
// We intentionally do not invent a publication payload schema here.
// The browser sends the exact body supported by the AITuber account/API.
app.post("/api/publications", async (req, res) => {
  if (!requireKey(res)) return;

  try {
    const data = await aituber("/publications", {
      method: "POST",
      body: JSON.stringify(req.body || {})
    });

    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message,
      details: err.data || null
    });
  }
});

app.get("/api/publications/:publicationId", async (req, res) => {
  if (!requireKey(res)) return;

  try {
    const data = await aituber(
      `/publications/${encodeURIComponent(req.params.publicationId)}`
    );
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message,
      details: err.data || null
    });
  }
});

// -----------------------------
// Mobile dashboard
// -----------------------------

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AITuber Content Autopilot V3</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#080d1c;color:#f4f6ff;font-family:Arial,sans-serif}
.wrap{max-width:1000px;margin:auto;padding:18px}
.card{background:#121a2d;border:1px solid #273453;border-radius:22px;padding:18px;margin:14px 0;box-shadow:0 8px 30px #0003}
h1{font-size:28px;margin:0 0 8px}
h2{font-size:21px;margin:0 0 12px}
p{color:#aeb8d1;line-height:1.5}
button{border:0;border-radius:14px;padding:13px 16px;font-weight:700;font-size:15px;background:#6555e9;color:white;margin:5px 4px 5px 0}
button.secondary{background:#263452}
button.danger{background:#7b3340}
input,textarea,select{width:100%;padding:13px;border-radius:12px;border:1px solid #33415f;background:#0b1224;color:#fff;margin:6px 0 12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.badge{display:inline-block;background:#263452;border-radius:999px;padding:7px 11px;color:#dce3f8;font-size:13px}
.video{border:1px solid #293758;background:#0d1427;border-radius:17px;padding:14px;margin:10px 0}
.video h3{margin:0 0 8px;font-size:18px}
.small{font-size:13px;color:#95a3c3}
.good{color:#72e1a4}.warn{color:#ffd27a}.bad{color:#ff929d}
a{color:#a9a0ff;word-break:break-all}
pre{white-space:pre-wrap;word-break:break-word;background:#080d1a;border-radius:12px;padding:12px;color:#cbd4ea;font-size:12px}
.hidden{display:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>🎬 AITuber Content Autopilot V3</h1>
    <p>
      Existing-video mode: finds videos already in your AITuber account,
      exports completed videos to MP4, and gives you a download link.
      It does not generate new videos, so it will not spend generation credits.
    </p>
    <button onclick="loadVideos()">🔄 Refresh My Videos</button>
    <button onclick="syncVideos()">⚡ Export Completed Videos</button>
    <button class="secondary" onclick="loadChannels()">📡 Check Channels</button>
    <div id="message" class="small"></div>
  </div>

  <div class="card">
    <h2>📊 Account / Channel Status</h2>
    <div id="channels">Tap "Check Channels".</div>
  </div>

  <div class="card">
    <h2>🎞️ My AITuber Videos</h2>
    <div id="videos">Loading...</div>
  </div>

  <div class="card">
    <h2>⚙️ Export Jobs</h2>
    <div id="jobs">Loading...</div>
  </div>

  <div class="card">
    <h2>📤 Publication API</h2>
    <p>
      Publishing requires an active AITuber plan and at least one connected
      account. The server includes the publication API proxy without guessing
      platform-specific fields.
    </p>
    <textarea id="pubBody" rows="7" placeholder='Paste the exact AITuber publication JSON here, for example:
{
  "videoId": "YOUR_VIDEO_ID"
}'></textarea>
    <button onclick="publish()">🚀 Send Publication Request</button>
    <div id="pubResult"></div>
  </div>
</div>

<script>
async function api(url, options={}) {
  const r = await fetch(url, {
    headers: {"Content-Type":"application/json"},
    ...options
  });
  const data = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error || "Request failed");
  return data;
}

function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function msg(text, cls="small"){
  document.getElementById("message").className = cls;
  document.getElementById("message").textContent = text;
}

async function loadVideos(){
  const el=document.getElementById("videos");
  el.innerHTML="Loading AITuber videos...";
  try{
    const data=await api("/api/videos");
    const videos=data.videos || [];
    if(!videos.length){
      el.innerHTML="<p>No videos returned by AITuber.</p>";
      return;
    }

    el.innerHTML=videos.map(v=>{
      const ready = v.status === "completed";
      const exported = v.exportStatus === "completed";
      return '<div class="video">' +
        '<h3>🎥 '+esc(v.title)+'</h3>' +
        '<div class="small">ID: '+esc(v.id)+'</div>' +
        '<p>Video status: <span class="'+(ready?"good":"warn")+'">'+
          esc(v.status)+'</span><br>' +
          'Export status: <span class="'+(exported?"good":"warn")+'">'+
          esc(v.exportStatus || "not exported")+'</span></p>' +
        (ready && !exported
          ? '<button onclick="startExport(\\''+esc(v.id)+'\\')">📦 Export MP4</button>'
          : '') +
        (exported
          ? '<button onclick="getDownload(\\''+esc(v.id)+'\\')">⬇️ Get Download Link</button>'
          : '') +
        '<div id="dl-'+esc(v.id)+'"></div>' +
      '</div>';
    }).join("");
    msg("Videos loaded.");
  }catch(e){
    el.innerHTML='<p class="bad">'+esc(e.message)+'</p>';
    msg("Could not load videos.","bad");
  }
}

async function startExport(videoId){
  try{
    await api("/api/export/"+encodeURIComponent(videoId),{method:"POST"});
    msg("Export started for "+videoId);
    loadJobs();
  }catch(e){
    msg(e.message,"bad");
  }
}

async function getDownload(videoId){
  try{
    const v=await api("/api/video/"+encodeURIComponent(videoId));
    if(v.video && v.video.exportStatus !== "completed"){
      msg("This video is not exported yet.","warn");
      return;
    }

    // Ask the server for a fresh signed URL.
    const r=await fetch("/api/video/"+encodeURIComponent(videoId));
    const latest=await r.json();

    // Use the dedicated download endpoint through the server-side API.
    const d=await api("/api/download/"+encodeURIComponent(videoId));
    document.getElementById("dl-"+videoId).innerHTML =
      '<p class="good">MP4 ready:</p><a target="_blank" rel="noopener" href="'+
      esc(d.downloadUrl)+'">Open / download MP4</a>';
  }catch(e){
    // This route may not be available in older deployments; show a clear message.
    document.getElementById("dl-"+videoId).innerHTML =
      '<p class="bad">'+esc(e.message)+'</p>';
  }
}

async function syncVideos(){
  msg("Scanning AITuber and starting exports...");
  try{
    const data=await api("/api/sync",{method:"POST"});
    msg("Export scan started. Refresh jobs in a few seconds.","good");
    loadJobs();
  }catch(e){
    msg(e.message,"bad");
  }
}

async function loadJobs(){
  const el=document.getElementById("jobs");
  try{
    const data=await api("/api/jobs");
    const jobs=data.jobs || [];
    if(!jobs.length){
      el.innerHTML="<p>No export jobs yet.</p>";
      return;
    }
    el.innerHTML=jobs.map(j=>
      '<div class="video">'+
      '<h3>'+esc(j.videoId)+'</h3>'+
      '<p>Status: <span class="'+
      (j.status==="exported"?"good":j.status==="failed"?"bad":"warn")+
      '">'+esc(j.status)+'</span></p>'+
      (j.exportStatus?'<p>Export: '+esc(j.exportStatus)+'</p>':'')+
      (j.error?'<p class="bad">'+esc(j.error)+'</p>':'')+
      (j.downloadUrl?
        '<p><a target="_blank" rel="noopener" href="'+esc(j.downloadUrl)+
        '">⬇️ Open MP4 download</a></p>':'')+
      (j.status==="failed"?
        '<button onclick="retryJob(\\''+esc(j.id)+'\\')">↻ Retry Export</button>':'')+
      '</div>'
    ).join("");
  }catch(e){
    el.innerHTML='<p class="bad">'+esc(e.message)+'</p>';
  }
}

async function retryJob(id){
  try{
    await api("/api/jobs/"+encodeURIComponent(id)+"/retry",{method:"POST"});
    loadJobs();
  }catch(e){ msg(e.message,"bad"); }
}

async function loadChannels(){
  const el=document.getElementById("channels");
  el.innerHTML="Loading connected channels...";
  try{
    const data=await api("/api/channels");
    el.innerHTML="<pre>"+esc(JSON.stringify(data,null,2))+"</pre>";
  }catch(e){
    el.innerHTML='<p class="bad">'+esc(e.message)+'</p>';
  }
}

async function publish(){
  const result=document.getElementById("pubResult");
  try{
    const raw=document.getElementById("pubBody").value.trim();
    if(!raw) throw new Error("Enter the publication JSON first.");
    const body=JSON.parse(raw);
    const data=await api("/api/publications",{
      method:"POST",
      body:JSON.stringify(body)
    });
    result.innerHTML="<pre>"+esc(JSON.stringify(data,null,2))+"</pre>";
  }catch(e){
    result.innerHTML='<p class="bad">'+esc(e.message)+'</p>';
  }
}

async function poll(){
  await loadJobs();
  setTimeout(poll,15000);
}

loadVideos();
loadJobs();
poll();
</script>
</body>
</html>`;

app.get("/", (req, res) => {
  res.type("html").send(html);
});

// Fresh signed download URL endpoint.
app.get("/api/download/:videoId", async (req, res) => {
  if (!requireKey(res)) return;

  try {
    const url = await getDownloadUrl(req.params.videoId);

    if (!url) {
      return res.status(404).json({
        error: "AITuber did not return a signed download URL."
      });
    }

    res.json({ downloadUrl: url });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message,
      details: err.data || null
    });
  }
});

app.listen(PORT, () => {
  console.log(`AITuber Content Autopilot V3 running on port ${PORT}`);
});
