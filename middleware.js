const cookieParser = require("cookie-parser");

let VOTING_LOCKED = false;
const ADMIN_KEY = process.env.ADMIN_KEY || "newyear";

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
  return p.startsWith("/") ? p : `/${p}`;
}

module.exports = { requireAdmin, getVoteState, setVoteState, relPath, VOTING_LOCKED };