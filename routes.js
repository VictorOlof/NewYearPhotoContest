const express = require("express");
const multer = require("multer");
const { db } = require("./db");
const { requireAdmin, getVoteState, setVoteState, relPath } = require("./middleware");
const path = require("path");

const router = express.Router();
const uploadsDir = path.join(__dirname, "uploads");
const fs = require("fs");

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
  return (
    file.mimetype.startsWith("image/") ||
    [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"].includes(
      (path.extname(file.originalname) || "").toLowerCase()
    )
  );
}

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (!isLikelyImage(file)) return cb(new Error("Only image uploads are allowed."));
    cb(null, true);
  },
});

// ====== API: submissions list ======
router.get("/api/submissions", (req, res) => {
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
router.post("/api/upload", upload.single("image"), async (req, res) => {
  // Upload logic (same as in server.js)
});

// ====== API: voting ======
router.post("/api/vote/:id", (req, res) => {
  // Voting logic (same as in server.js)
});

// ====== API: lock/unlock/status ======
router.get("/api/status", (req, res) => {
  res.json({ votingLocked: VOTING_LOCKED });
});

router.post("/api/admin/lock", (req, res) => {
  if (!requireAdmin(req, res)) return;
  VOTING_LOCKED = true;
  res.json({ ok: true, votingLocked: true });
});

router.post("/api/admin/unlock", (req, res) => {
  if (!requireAdmin(req, res)) return;
  VOTING_LOCKED = false;
  res.json({ ok: true, votingLocked: false });
});

// ====== Pages ======
router.get("/", (req, res) => res.sendFile(path.join(__dirname, "views", "submit.html")));
// ... other page routes ...

// Your upload page file is submit.html
router.get("/upload", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "submit.html"))
);

router.get("/results", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "results.html"))
);


// Optional: keep /submit working too (nice for your own links)
router.get("/submit", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "submit.html"))
);

router.get("/winner", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "winner.html"))
);

router.get("/gallery", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "gallery.html"))
);

router.get("/wall", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "wall.html"))
);

router.get("/slideshow", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "slideshow.html"))
);

router.get("/top3", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "top3.html"))
);

router.get("/admin", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "admin.html"))
);

router.get("/reveal", (req, res) =>
  res.sendFile(path.join(__dirname, "views", "reveal.html"))
);

module.exports = router;