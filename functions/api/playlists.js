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

export async function onRequest({ env, request }) {
  const url = new URL(request.url);
  const limit = clamp(parseInt(url.searchParams.get("limit") || "24", 10), 1, 60);
  const cur = decodeCursor(url.searchParams.get("cursor"));

  const hasThumbId = await hasColumn(env, "playlists", "thumb_video_id")
    || await hasColumn(env, "playlists", "thumbnail_video_id");

  const thumbExpr = hasThumbId
    ? (await hasColumn(env, "playlists", "thumb_video_id")
        ? "p.thumb_video_id AS thumb_video_id"
        : "p.thumbnail_video_id AS thumb_video_id")
    : `(SELECT pv.video_id FROM playlist_videos pv WHERE pv.playlist_id=p.playlist_id LIMIT 1) AS thumb_video_id`;

  const where = cur
    ? `WHERE (COALESCE(p.published_at,0) < ? OR (COALESCE(p.published_at,0) = ? AND p.playlist_id < ?))`
    : ``;

  const binds = cur ? [cur.ts, cur.ts, cur.id, limit] : [limit];

  const sql = `
    SELECT
      p.playlist_id,
      p.title,
      p.published_at,
      p.item_count,
      c.channel_id,
      c.title AS channel_title,
      ${await hasColumn(env, "channels", "thumbnail_url") ? "c.thumbnail_url AS channel_thumbnail_url" : "NULL AS channel_thumbnail_url"},
      ${thumbExpr}
    FROM playlists p
    JOIN channels c ON c.id = p.channel_int
    ${where}
    ORDER BY COALESCE(p.published_at,0) DESC, p.playlist_id DESC
    LIMIT ?
  `;

  const rows = await env.DB.prepare(sql).bind(...binds).all();
  const playlists = rows.results || [];

  let next_cursor = null;
  if (playlists.length === limit) {
    const last = playlists[playlists.length - 1];
    next_cursor = encodeCursor(last.published_at || 0, last.playlist_id);
  }

  return json({ playlists, next_cursor }, 200, { "cache-control": "public, max-age=120" });
}

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
