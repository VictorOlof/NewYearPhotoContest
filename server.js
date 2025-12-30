// server.js
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const Database = require("better-sqlite3");
const sharp = require("sharp");
const { Storage } = require("@google-cloud/storage");

const app = express();
const PORT = process.env.PORT || 3000;

// ====== Google Cloud Storage ======
// You can also set env var GCS_BUCKET=photo-booth-bucket in Cloud Run.
const BUCKET_NAME = process.env.GCS_BUCKET || "photo-booth-bucket";
const storageClient = new Storage(); // Uses Cloud Run service account automatically
const bucket = storageClient.bucket(BUCKET_NAME);

// Public URL helper (works with "Uniform access + allUsers: Storage Object Viewer")
function publicUrlFor(objectName) {
  return `https://storage.googleapis.com/${BUCKET_NAME}/${encodeURIComponent(objectName).replace(/%2F/g, "/")}`;
}

// If you ever need to delete the GCS object from a stored URL
function objectNameFromUrl(url) {
  // Accept either:
  // https://storage.googleapis.com/<bucket>/<object>
  // https://storage.cloud.google.com/<bucket>/<object> (not recommended for public)
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    // storage.googleapis.com/<bucket>/<object...>
    if (u.hostname === "storage.googleapis.com" && parts[0] === BUCKET_NAME) {
      return parts.slice(1).join("/");
    }
    // If URL stored is already an object name, return it
    return null;
  } catch {
    return null;
  }
}

// ====== Basic config ======
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Cache static assets
app.use(
  "/public",
  express.static(path.join(__dirname, "public"), { maxAge: "7d", etag: true })
);

// NOTE: We DO NOT serve /uploads from disk anymore.
// Images will be served directly from GCS public URLs.

// ====== Admin + voting lock ======
let VOTING_LOCKED = false;
const ADMIN_KEY = process.env.ADMIN_KEY || "newyear";

// ====== Database ======
const db = new Database(path.join(__dirname, "db.sqlite"));

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    imagePath TEXT NOT NULL,
    thumbPath TEXT,
    displayPath TEXT,
    votes INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

if (!columnExists("submissions", "thumbPath")) {
  db.exec(`ALTER TABLE submissions ADD COLUMN thumbPath TEXT;`);
}
if (!columnExists("submissions", "displayPath")) {
  db.exec(`ALTER TABLE submissions ADD COLUMN displayPath TEXT;`);
}

// ====== Multer (memory, no file size limit in multer) ======
// NOTE: Cloud Run has its own request size limits; extremely large uploads may fail upstream.
function isLikelyImage(file) {
  return (
    file.mimetype.startsWith("image/") ||
    [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"].includes(
      (path.extname(file.originalname) || "").toLowerCase()
    )
  );
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (!isLikelyImage(file)) return cb(new Error("Only image uploads are allowed."));
    cb(null, true);
  },
});

// ====== Helpers ======
function requireAdmin(req, res) {
  const key = req.query.key;
  if (key !== ADMIN_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function getVoteState(req) {
  const raw = req.cookies.voteState || "{}";
  const state = safeJsonParse(raw, {});
  state.total = state.total || 0;
  state.perImage = state.perImage || {};
  return state;
}

function setVoteState(res, state) {
  res.cookie("voteState", JSON.stringify(state), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
}

// If old code expects "/uploads/..", keep compatibility:
// - If it's already a full URL (http/https), return it as-is.
// - Otherwise prefix with "/" for your local routes (not used anymore).
function relPath(p) {
  if (!p) return p;
  if (p.startsWith("http://") || p.startsWith("https://")) return p;
  return p.startsWith("/") ? p : `/${p}`;
}

// Upload a buffer to GCS
async function uploadBufferToGCS(objectName, buffer, contentType) {
  const file = bucket.file(objectName);
  await file.save(buffer, {
    resumable: false,
    contentType: contentType || "application/octet-stream",
    // We rely on bucket-level public read IAM. No per-object ACL needed.
    metadata: {
      cacheControl: "public, max-age=604800", // 7 days
    },
  });
  return publicUrlFor(objectName);
}

// ====== Pages ======
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "views", "submit.html")));
app.get("/upload", (req, res) => res.sendFile(path.join(__dirname, "views", "submit.html")));
app.get("/results", (req, res) => res.sendFile(path.join(__dirname, "views", "results.html")));
app.get("/submit", (req, res) => res.sendFile(path.join(__dirname, "views", "submit.html")));
app.get("/winner", (req, res) => res.sendFile(path.join(__dirname, "views", "winner.html")));
app.get("/gallery", (req, res) => res.sendFile(path.join(__dirname, "views", "gallery.html")));
app.get("/wall", (req, res) => res.sendFile(path.join(__dirname, "views", "wall.html")));
app.get("/slideshow", (req, res) => res.sendFile(path.join(__dirname, "views", "slideshow.html")));
app.get("/top3", (req, res) => res.sendFile(path.join(__dirname, "views", "top3.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "views", "admin.html")));
app.get("/reveal", (req, res) => res.sendFile(path.join(__dirname, "views", "reveal.html")));

// ====== API: submissions list ======
app.get("/api/submissions", (req, res) => {
  const rows = db
    .prepare(
      `
      SELECT id, name, imagePath, thumbPath, displayPath, votes, createdAt
      FROM submissions
      ORDER BY votes DESC, id ASC
    `
    )
    .all();

  res.json(
    rows.map((r) => ({
      ...r,
      imagePath: relPath(r.imagePath),
      thumbPath: r.thumbPath ? relPath(r.thumbPath) : null,
      displayPath: r.displayPath ? relPath(r.displayPath) : null,
    }))
  );
});

// ====== API: upload (to GCS) ======
app.post("/api/upload", upload.single("image"), async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).send("Name is required");
    if (!req.file) return res.status(400).send("Image is required");

    // Create unique base name
    const safeExt = (path.extname(req.file.originalname) || "").toLowerCase() || ".jpg";
    const base = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    // We'll store objects under these folders:
    // originals/<base>.<ext>
    // display/display-<base>.jpg
    // thumbs/thumb-<base>.jpg
    const originalObject = `originals/${base}${safeExt}`;
    const displayObject = `display/display-${base}.jpg`;
    const thumbObject = `thumbs/thumb-${base}.jpg`;

    // Upload original
    const originalUrl = await uploadBufferToGCS(
      originalObject,
      req.file.buffer,
      req.file.mimetype
    );

    // Generate resized versions using sharp (in-memory)
    let displayUrl = originalUrl;
    let thumbUrl = originalUrl;

    try {
      const displayBuf = await sharp(req.file.buffer)
        .rotate()
        .resize({ width: 1600, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();

      const thumbBuf = await sharp(req.file.buffer)
        .rotate()
        .resize({ width: 600, withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();

      displayUrl = await uploadBufferToGCS(displayObject, displayBuf, "image/jpeg");
      thumbUrl = await uploadBufferToGCS(thumbObject, thumbBuf, "image/jpeg");
    } catch (e) {
      console.error("sharp failed (using original only):", e.message);
    }

    const info = db
      .prepare(
        `
        INSERT INTO submissions (name, imagePath, thumbPath, displayPath, votes, createdAt)
        VALUES (?, ?, ?, ?, 0, datetime('now'))
      `
      )
      .run(name, originalUrl, thumbUrl, displayUrl);

    // Prevent self-voting by storing their submission id
    res.cookie("mySubmissionId", String(info.lastInsertRowid), {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });

    res.redirect("/gallery");
  } catch (err) {
    console.error("upload route failed:", err);
    res.status(500).send("Upload failed");
  }
});

// ====== API: voting ======
app.post("/api/vote/:id", (req, res) => {
  if (VOTING_LOCKED) {
    return res.status(403).json({ error: "Voting is locked" });
  }

  const id = String(req.params.id);

  // Block self-voting (strong version)
  const mySubmissionId = req.cookies.mySubmissionId;
  if (mySubmissionId && String(mySubmissionId) === String(id)) {
    return res.status(403).json({ error: "You can’t vote for your own picture" });
  }

  const state = getVoteState(req);

  const usedTotal = state.total;
  const usedForImage = state.perImage[id] || 0;

  if (usedTotal >= 3) {
    return res.status(403).json({ error: "You have already used all 3 votes" });
  }
  if (usedForImage >= 2) {
    return res.status(403).json({ error: "You can only vote 2 times for the same image" });
  }

  const exists = db.prepare("SELECT id FROM submissions WHERE id = ?").get(id);
  if (!exists) return res.status(404).json({ error: "Image not found" });

  db.prepare("UPDATE submissions SET votes = votes + 1 WHERE id = ?").run(id);

  state.total += 1;
  state.perImage[id] = usedForImage + 1;
  setVoteState(res, state);

  res.json({
    ok: true,
    votesRemaining: 3 - state.total,
    votesForThisImage: state.perImage[id],
  });
});

app.get("/api/votes-remaining", (req, res) => {
  const state = getVoteState(req);
  res.json({ votesRemaining: Math.max(0, 3 - (state.total || 0)) });
});

// ====== API: lock/unlock/status ======
app.get("/api/status", (req, res) => {
  res.json({ votingLocked: VOTING_LOCKED });
});

app.post("/api/admin/lock", (req, res) => {
  if (!requireAdmin(req, res)) return;
  VOTING_LOCKED = true;
  res.json({ ok: true, votingLocked: true });
});

app.post("/api/admin/unlock", (req, res) => {
  if (!requireAdmin(req, res)) return;
  VOTING_LOCKED = false;
  res.json({ ok: true, votingLocked: false });
});

// ====== API: admin rename/delete ======
app.put("/api/admin/submissions/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const id = Number(req.params.id);
  const name = (req.body.name || "").trim();

  if (!name) return res.status(400).json({ error: "Name is required" });
  if (name.length > 50) return res.status(400).json({ error: "Name too long (max 50)" });

  const info = db.prepare("UPDATE submissions SET name = ? WHERE id = ?").run(name, id);
  if (info.changes === 0) return res.status(404).json({ error: "Not found" });

  res.json({ ok: true });
});

app.delete("/api/admin/submissions/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const id = Number(req.params.id);

  const row = db
    .prepare("SELECT imagePath, thumbPath, displayPath FROM submissions WHERE id = ?")
    .get(id);

  if (!row) return res.status(404).json({ error: "Not found" });

  db.prepare("DELETE FROM submissions WHERE id = ?").run(id);

  // Delete from GCS (best-effort)
  const urls = [row.imagePath, row.thumbPath, row.displayPath].filter(Boolean);
  for (const url of urls) {
    const objectName = objectNameFromUrl(url);
    if (!objectName) continue;
    try {
      await bucket.file(objectName).delete({ ignoreNotFound: true });
    } catch (e) {
      console.warn("Failed to delete object:", objectName, e.message);
    }
  }

  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  res.json({ mySubmissionId: req.cookies.mySubmissionId || null });
});

// ====== API: stats ======
app.get("/api/stats", (req, res) => {
  const ranked = db
    .prepare(
      `
      SELECT id, name, imagePath, thumbPath, displayPath, votes, createdAt
      FROM submissions
      ORDER BY votes DESC, id ASC
    `
    )
    .all()
    .map((r) => ({
      ...r,
      imagePath: relPath(r.imagePath),
      thumbPath: r.thumbPath ? relPath(r.thumbPath) : null,
      displayPath: r.displayPath ? relPath(r.displayPath) : null,
    }));

  const totalVotes = ranked.reduce((sum, r) => sum + (r.votes || 0), 0);
  const top3 = ranked.slice(0, 3);
  const winner = ranked[0] || null;
  const runnerUp = ranked[1] || null;
  const margin = winner && runnerUp ? (winner.votes || 0) - (runnerUp.votes || 0) : null;

  let tightest = null;
  for (let i = 0; i < ranked.length - 1; i++) {
    const gap = (ranked[i].votes || 0) - (ranked[i + 1].votes || 0);
    if (tightest === null || gap < tightest.gap) {
      tightest = { a: ranked[i], b: ranked[i + 1], gap, indexA: i + 1, indexB: i + 2 };
    }
  }

  const halfIndex = Math.floor(ranked.length / 2);
  const darkHorse = ranked.slice(halfIndex)[0] || null;

  const latestFive = db
    .prepare(
      `
      SELECT id, name, imagePath, thumbPath, displayPath, votes, createdAt
      FROM submissions
      ORDER BY datetime(createdAt) DESC
      LIMIT 5
    `
    )
    .all()
    .map((r) => ({
      ...r,
      imagePath: relPath(r.imagePath),
      thumbPath: r.thumbPath ? relPath(r.thumbPath) : null,
      displayPath: r.displayPath ? relPath(r.displayPath) : null,
    }));

  const lateEntryHero =
    latestFive.sort((a, b) => (b.votes || 0) - (a.votes || 0))[0] || null;

  res.json({
    totalVotes,
    count: ranked.length,
    ranked,
    top3,
    winner,
    runnerUp,
    margin,
    tightest,
    darkHorse,
    lateEntryHero,
  });
});

// ====== Start server ======
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
