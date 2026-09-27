const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;
const AITUBER_API_KEY = process.env.AITUBER_API_KEY;
const AITUBER_BASE = "https://app.aituber.app/api/v1";

app.use(express.json({ limit: "1mb" }));

function authHeaders() {
  return {
    "Authorization": `Bearer ${AITUBER_API_KEY}`,
    "Content-Type": "application/json"
  };
}

async function aituberRequest(path, options = {}) {
  if (!AITUBER_API_KEY) {
    throw new Error("AITUBER_API_KEY is not configured in Render.");
  }

  const response = await fetch(`${AITUBER_BASE}${path}`, {
    ...options,
    headers: {
      ...authHeaders(),
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
      data?.errorMessage ||
      `AITuber API returned HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AITuber Content Autopilot V1",
    aituberKeyConfigured: Boolean(AITUBER_API_KEY),
    time: new Date().toISOString()
  });
});

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Content Autopilot</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0b1020;color:#fff;margin:0}
.wrap{max-width:900px;margin:auto;padding:22px}
.card{background:#151c31;border:1px solid #293451;border-radius:18px;padding:18px;margin-bottom:16px}
h1{margin:0 0 6px;font-size:28px}
p{color:#aeb8d0}
label{display:block;margin:14px 0 7px;color:#dbe2f3}
textarea,input,select,button{width:100%;box-sizing:border-box;border-radius:12px;border:1px solid #35415f;background:#0e1528;color:#fff;padding:13px;font-size:15px}
textarea{min-height:130px;resize:vertical}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
button{margin-top:16px;background:#6d5dfc;border:0;font-weight:700;cursor:pointer}
button:disabled{opacity:.5}
.status{white-space:pre-wrap;background:#0a0f1d;padding:14px;border-radius:12px;color:#cbd5e1}
a{color:#9bb7ff}
.small{font-size:13px;color:#8792aa}
@media(max-width:650px){.row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>🎬 AI Content Autopilot</h1>
    <p>AITuber Video Generator — V1</p>
  </div>

  <div class="card">
    <label>Video idea</label>
    <textarea id="script" placeholder="Example: 5 surprising facts about Kenya that most people don't know"></textarea>

    <div class="row">
      <div>
        <label>Duration</label>
        <select id="duration">
          <option value="30">30 seconds</option>
          <option value="45" selected>45 seconds</option>
          <option value="60">60 seconds</option>
        </select>
      </div>
      <div>
        <label>Format</label>
        <select id="aspect">
          <option value="9:16" selected>9:16 Shorts / Reels / TikTok</option>
          <option value="16:9">16:9 YouTube</option>
          <option value="1:1">1:1 Instagram</option>
        </select>
      </div>
    </div>

    <button id="generate" onclick="generateVideo()">🚀 Generate Video</button>
    <p class="small">Your AITuber API key stays on the Render server.</p>
  </div>

  <div class="card">
    <h3>Generation status</h3>
    <div id="status" class="status">Waiting for a video...</div>
    <div id="actions"></div>
  </div>
</div>

<script>
let videoId = null;
let timer = null;

function show(obj) {
  document.getElementById("status").textContent =
    typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

async function generateVideo() {
  const button = document.getElementById("generate");
  const script = document.getElementById("script").value.trim();
  const duration = Number(document.getElementById("duration").value);
  const aspectRatio = document.getElementById("aspect").value;

  if (!script) {
    show("Enter a video idea first.");
    return;
  }

  button.disabled = true;
  document.getElementById("actions").innerHTML = "";
  show("Creating your AITuber video...");

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        script,
        inputType: "idea",
        expectedDurationSeconds: duration,
        aspectRatio,
        captionStyleId: "wrap-1"
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Generation failed.");

    videoId = data.videoId || data.id;
    show(data);

    if (!videoId) throw new Error("AITuber did not return a videoId.");

    clearInterval(timer);
    timer = setInterval(checkStatus, 15000);
    await checkStatus();
  } catch (e) {
    show("ERROR: " + e.message);
    button.disabled = false;
  }
}

async function checkStatus() {
  if (!videoId) return;

  try {
    const response = await fetch("/api/status/" + encodeURIComponent(videoId));
    const data = await response.json();
    show(data);

    const status = data.status || data.data?.status;

    if (status === "completed") {
      clearInterval(timer);
      document.getElementById("generate").disabled = false;
      document.getElementById("actions").innerHTML =
        '<button onclick="requestExport()">🎞️ Export MP4</button>';
    }

    if (status === "failed") {
      clearInterval(timer);
      document.getElementById("generate").disabled = false;
      document.getElementById("actions").innerHTML =
        '<p style="color:#ff8b8b">Generation failed. Check the status above.</p>';
    }
  } catch (e) {
    show("Status check error: " + e.message);
  }
}

async function requestExport() {
  if (!videoId) return;

  document.getElementById("actions").innerHTML = "<p>Requesting MP4 export...</p>";

  try {
    const response = await fetch("/api/export/" + encodeURIComponent(videoId), {
      method: "POST"
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Export failed.");

    show(data);
    clearInterval(timer);
    timer = setInterval(checkExport, 15000);
    await checkExport();
  } catch (e) {
    show("EXPORT ERROR: " + e.message);
  }
}

async function checkExport() {
  if (!videoId) return;

  try {
    const response = await fetch("/api/status/" + encodeURIComponent(videoId));
    const data = await response.json();
    show(data);

    const exportStatus = data.exportStatus || data.data?.exportStatus;

    if (exportStatus === "completed") {
      clearInterval(timer);
      document.getElementById("actions").innerHTML =
        '<button onclick="getDownload()">⬇️ Get MP4 Download Link</button>';
    }
  } catch (e) {
    show("Export status error: " + e.message);
  }
}

async function getDownload() {
  try {
    const response = await fetch("/api/download/" + encodeURIComponent(videoId));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not get download URL.");

    show(data);
    if (data.downloadUrl) {
      document.getElementById("actions").innerHTML =
        '<a href="' + data.downloadUrl + '" target="_blank" rel="noopener">🎥 Open / Download MP4</a>';
    }
  } catch (e) {
    show("DOWNLOAD ERROR: " + e.message);
  }
}
</script>
</body>
</html>`);
});

app.post("/api/generate", async (req, res) => {
  try {
    const {
      script,
      inputType = "idea",
      expectedDurationSeconds = 45,
      aspectRatio = "9:16",
      captionStyleId = "wrap-1"
    } = req.body || {};

    if (!script || typeof script !== "string") {
      return res.status(400).json({ error: "script/video idea is required" });
    }

    if (script.length > 10000) {
      return res.status(400).json({ error: "The idea/script is too long. Maximum is 10,000 characters." });
    }

    const payload = {
      script: script.trim(),
      inputType,
      expectedDurationSeconds: Number(expectedDurationSeconds),
      aspectRatio,
      captionStyleId
    };

    const data = await aituberRequest("/videos/generate", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    res.json(data);
  } catch (error) {
    console.error("Generate error:", error);
    res.status(error.status || 500).json({
      error: error.message,
      details: error.data || null
    });
  }
});

app.get("/api/status/:videoId", async (req, res) => {
  try {
    const data = await aituberRequest(`/videos/${encodeURIComponent(req.params.videoId)}`);
    res.json(data);
  } catch (error) {
    console.error("Status error:", error);
    res.status(error.status || 500).json({
      error: error.message,
      details: error.data || null
    });
  }
});

app.post("/api/export/:videoId", async (req, res) => {
  try {
    const data = await aituberRequest("/exports", {
      method: "POST",
      body: JSON.stringify({ videoId: req.params.videoId })
    });
    res.json(data);
  } catch (error) {
    console.error("Export error:", error);
    res.status(error.status || 500).json({
      error: error.message,
      details: error.data || null
    });
  }
});

app.get("/api/download/:videoId", async (req, res) => {
  try {
    const data = await aituberRequest(
      `/exports/download?videoId=${encodeURIComponent(req.params.videoId)}`,
      { method: "GET" }
    );

    const downloadUrl =
      data.downloadUrl ||
      data.url ||
      data.signedUrl ||
      data.download_url ||
      null;

    if (!downloadUrl) {
      return res.status(502).json({
        error: "AITuber did not return a download URL.",
        response: data
      });
    }

    res.json({ downloadUrl });
  } catch (error) {
    console.error("Download URL error:", error);
    res.status(error.status || 500).json({
      error: error.message,
      details: error.data || null
    });
  }
});

app.listen(PORT, () => {
  console.log(`AITuber Content Autopilot running on port ${PORT}`);
});
