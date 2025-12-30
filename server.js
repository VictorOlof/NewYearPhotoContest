// server.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const Database = require("better-sqlite3");
const sharp = require("sharp");

const app = express();
const PORT = process.env.PORT || 3000;

// ====== Basic config ======
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Cache static assets (helps a lot for /wall and ngrok)
app.use(
  "/public",
  express.static(path.join(__dirname, "public"), { maxAge: "7d", etag: true })
);
app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"), { maxAge: "7d", etag: true })
);

// Ensure folders exist
const uploadsDir = path.join(__dirname, "uploads");
const thumbsDir = path.join(uploadsDir, "thumbs");
const displayDir = path.join(uploadsDir, "display");
for (const dir of [uploadsDir, thumbsDir, displayDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

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

// If you had older DB schema, add columns if missing
if (!columnExists("submissions", "thumbPath")) {
  db.exec(`ALTER TABLE submissions ADD COLUMN thumbPath TEXT;`);
}
if (!columnExists("submissions", "displayPath")) {
  db.exec(`ALTER TABLE submissions ADD COLUMN displayPath TEXT;`);
}

// ====== Multer (no file size limit) ======
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safeExt = (path.extname(file.originalname) || "").toLowerCase();
    const base = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    cb(null, `${base}${safeExt}`);
  },
});

function isLikelyImage(file) {
  // Accept common image mimetypes; you can loosen this if you want
  return (
    file.mimetype.startsWith("image/") ||
    [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"].includes(
      (path.extname(file.originalname) || "").toLowerCase()
    )
  );
}

const upload = multer({
  storage,
  // IMPORTANT: Do NOT set limits.fileSize, that’s what caused your earlier error.
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
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  });
}

function relPath(p) {
  // ensure "/uploads/..." format
  return p.startsWith("/") ? p : `/${p}`;
}

// ====== Pages ======
//app.get("/", (req, res) => res.redirect("/upload"));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "views", "submit.html")));

// ====== Pages ======
//app.get("/", (req, res) => res.redirect("/upload"));

// Your upload page file is submit.html
app.get("/upload", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "submit.html"))
);

app.get("/results", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "results.html"))
);


// Optional: keep /submit working too (nice for your own links)
app.get("/submit", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "submit.html"))
);

app.get("/winner", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "winner.html"))
);

app.get("/gallery", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "gallery.html"))
);

app.get("/wall", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "wall.html"))
);

app.get("/slideshow", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "slideshow.html"))
);

app.get("/top3", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "top3.html"))
);

app.get("/admin", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "admin.html"))
);

app.get("/reveal", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "reveal.html"))
);

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

// ====== API: upload ======
app.post("/api/upload", upload.single("image"), async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    if (!name) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).send("Name is required");
    }
    if (!req.file) return res.status(400).send("Image is required");

    const originalRel = `/uploads/${req.file.filename}`;
    const originalAbs = path.join(uploadsDir, req.file.filename);

    // Default: if sharp fails, we still save the submission with the original image
    let displayRel = originalRel;
    let thumbRel = originalRel;

    // Create resized versions (FAST over ngrok)
    const base = path.parse(req.file.filename).name;
    const displayName = `display-${base}.jpg`;
    const thumbName = `thumb-${base}.jpg`;

    const displayAbs = path.join(displayDir, displayName);
    const thumbAbs = path.join(thumbsDir, thumbName);

    try {
      await sharp(originalAbs)
        .rotate()
        .resize({ width: 1600, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toFile(displayAbs);

      await sharp(originalAbs)
        .rotate()
        .resize({ width: 600, withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toFile(thumbAbs);

      displayRel = `/uploads/display/${displayName}`;
      thumbRel = `/uploads/thumbs/${thumbName}`;
    } catch (e) {
      console.error("sharp failed (using original image instead):", e.message);
      // keep displayRel/thumbRel as originalRel
    }

    const info = db.prepare(`
      INSERT INTO submissions (name, imagePath, thumbPath, displayPath, votes, createdAt)
      VALUES (?, ?, ?, ?, 0, datetime('now'))
    `).run(name, originalRel, thumbRel, displayRel);

    const submissionId = info.lastInsertRowid;

    res.cookie("mySubmissionId", String(info.lastInsertRowid), {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 30
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

  // ✅ Block self-voting (strong version)
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
    return res
      .status(403)
      .json({ error: "You can only vote 2 times for the same image" });
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

// Votes left on page load
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
  if (name.length > 50)
    return res.status(400).json({ error: "Name too long (max 50)" });

  const info = db.prepare("UPDATE submissions SET name = ? WHERE id = ?").run(name, id);
  if (info.changes === 0) return res.status(404).json({ error: "Not found" });

  res.json({ ok: true });
});

app.delete("/api/admin/submissions/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const id = Number(req.params.id);

  const row = db
    .prepare("SELECT imagePath, thumbPath, displayPath FROM submissions WHERE id = ?")
    .get(id);

  if (!row) return res.status(404).json({ error: "Not found" });

  db.prepare("DELETE FROM submissions WHERE id = ?").run(id);

  // Delete files from disk (ignore errors)
  const paths = [row.imagePath, row.thumbPath, row.displayPath].filter(Boolean);
  for (const p of paths) {
    const abs = path.join(__dirname, p.replace(/^\//, ""));
    fs.unlink(abs, () => {});
  }

  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  res.json({ mySubmissionId: req.cookies.mySubmissionId || null });
});


// ====== API: stats (for reveal page) ======
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

  // tightest adjacent gap
  let tightest = null;
  for (let i = 0; i < ranked.length - 1; i++) {
    const gap = (ranked[i].votes || 0) - (ranked[i + 1].votes || 0);
    if (tightest === null || gap < tightest.gap) {
      tightest = { a: ranked[i], b: ranked[i + 1], gap, indexA: i + 1, indexB: i + 2 };
    }
  }

  const halfIndex = Math.floor(ranked.length / 2);
  const darkHorse = ranked.slice(halfIndex)[0] || null;

  // late entry hero: among last 5 uploads (by createdAt)
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
  console.log(`Server running on http://localhost:${PORT}`);
});
