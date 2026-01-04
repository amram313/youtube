function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function clamp(n, a, b) {
  n = Number.isFinite(n) ? n : a;
  return Math.max(a, Math.min(b, n));
}

function decodeCursor(cur) {
  if (!cur) return null;
  const s = String(cur);
  const i = s.indexOf(":");
  if (i === -1) return null;
  const ts = parseInt(s.slice(0, i), 10);
  const id = s.slice(i + 1);
  if (!Number.isFinite(ts) || !id) return null;
  return { ts, id };
}
function encodeCursor(ts, id) {
  return `${ts || 0}:${id}`;
}

function toFtsQuery(q) {
  // safe-ish: tokens + prefix
  const tokens = String(q)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map(t => t.replace(/["']/g, "").slice(0, 32))
    .filter(Boolean);

  if (!tokens.length) return "";
  return tokens.map(t => `${t}*`).join(" ");
}

export async function onRequest({ env, request }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const limit = clamp(parseInt(url.searchParams.get("limit") || "24", 10), 1, 60);
  const cur = decodeCursor(url.searchParams.get("cursor"));

  if (!q) return json({ videos: [], next_cursor: null }, 200, { "cache-control": "public, max-age=30" });

  const chThumb = await hasColumn(env, "channels", "thumbnail_url");

  // detect optional FTS
  const hasFts = await hasTable(env, "videos_fts");

  const cursorWhere = cur
    ? `AND (COALESCE(v.published_at,0) < ? OR (COALESCE(v.published_at,0) = ? AND v.video_id < ?))`
    : ``;

  let sql, binds;

  if (hasFts) {
    const ftsQ = toFtsQuery(q);
    sql = `
      SELECT
        v.video_id, v.title, v.published_at,
        c.channel_id, c.title AS channel_title,
        ${chThumb ? "c.thumbnail_url AS channel_thumbnail_url" : "NULL AS channel_thumbnail_url"}
      FROM videos_fts f
      JOIN videos v ON v.video_id = f.video_id
      JOIN channels c ON c.id = v.channel_int
      WHERE f.title MATCH ?
      ${cursorWhere}
      ORDER BY COALESCE(v.published_at,0) DESC, v.video_id DESC
      LIMIT ?
    `;
    binds = cur ? [ftsQ, cur.ts, cur.ts, cur.id, limit] : [ftsQ, limit];
  } else {
    // fallback LIKE (יכול להיות איטי ב-200k, אבל לפחות עובד)
    sql = `
      SELECT
        v.video_id, v.title, v.published_at,
        c.channel_id, c.title AS channel_title,
        ${chThumb ? "c.thumbnail_url AS channel_thumbnail_url" : "NULL AS channel_thumbnail_url"}
      FROM videos v
      JOIN channels c ON c.id = v.channel_int
      WHERE v.title LIKE ?
      ${cursorWhere}
      ORDER BY COALESCE(v.published_at,0) DESC, v.video_id DESC
      LIMIT ?
    `;
    const like = `%${q}%`;
    binds = cur ? [like, cur.ts, cur.ts, cur.id, limit] : [like, limit];
  }

  const rows = await env.DB.prepare(sql).bind(...binds).all();
  const videos = rows.results || [];

  let next_cursor = null;
  if (videos.length === limit) {
    const last = videos[videos.length - 1];
    next_cursor = encodeCursor(last.published_at || 0, last.video_id);
  }

  return json({ videos, next_cursor }, 200, { "cache-control": "public, max-age=30" });
}

/* helpers */
const _colsCache = new Map();
async function hasColumn(env, table, col) {
  const key = `${table}`;
  let set = _colsCache.get(key);
  if (!set) {
    const r = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    set = new Set((r.results || []).map(x => x.name));
    _colsCache.set(key, set);
  }
  return set.has(col);
}

const _tableCache = new Map();
async function hasTable(env, name) {
  if (_tableCache.has(name)) return _tableCache.get(name);
  const r = await env.DB.prepare(
    `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`
  ).bind(name).first();
  const ok = !!r?.ok;
  _tableCache.set(name, ok);
  return ok;
}
