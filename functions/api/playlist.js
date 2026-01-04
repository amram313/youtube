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
  const playlist_id = (url.searchParams.get("playlist_id") || "").trim();
  if (!playlist_id) return json({ error: "missing playlist_id" }, 400);

  const videos_limit = clamp(parseInt(url.searchParams.get("videos_limit") || "24", 10), 1, 60);
  const videos_cursor = decodeCursor(url.searchParams.get("videos_cursor"));

  const chThumb = await hasColumn(env, "channels", "thumbnail_url");

  // playlist meta + channel meta
  const p = await env.DB.prepare(`
    SELECT
      p.playlist_id, p.title, p.published_at, p.item_count,
      c.channel_id, c.title AS channel_title,
      ${chThumb ? "c.thumbnail_url AS channel_thumbnail_url" : "NULL AS channel_thumbnail_url"},
      ${(await hasColumn(env,"playlists","thumb_video_id") ? "p.thumb_video_id" :
        (await hasColumn(env,"playlists","thumbnail_video_id") ? "p.thumbnail_video_id" :
          "(SELECT pv.video_id FROM playlist_videos pv WHERE pv.playlist_id=p.playlist_id LIMIT 1)"
        ))} AS thumb_video_id
    FROM playlists p
    JOIN channels c ON c.id = p.channel_int
    WHERE p.playlist_id=?
    LIMIT 1
  `).bind(playlist_id).first();

  if (!p) return json({ playlist: null }, 404);

  const where = videos_cursor
    ? `AND (COALESCE(v.published_at,0) < ? OR (COALESCE(v.published_at,0) = ? AND v.video_id < ?))`
    : ``;

  const binds = videos_cursor
    ? [playlist_id, videos_cursor.ts, videos_cursor.ts, videos_cursor.id, videos_limit]
    : [playlist_id, videos_limit];

  const rows = await env.DB.prepare(`
    SELECT
      v.video_id, v.title, v.published_at,
      c.channel_id, c.title AS channel_title,
      ${chThumb ? "c.thumbnail_url AS channel_thumbnail_url" : "NULL AS channel_thumbnail_url"}
    FROM playlist_videos pv
    JOIN videos v ON v.video_id = pv.video_id
    JOIN channels c ON c.id = v.channel_int
    WHERE pv.playlist_id=?
    ${where}
    ORDER BY COALESCE(v.published_at,0) DESC, v.video_id DESC
    LIMIT ?
  `).bind(...binds).all();

  const videos = rows.results || [];
  const videos_next_cursor = (videos.length === videos_limit)
    ? encodeCursor(videos[videos.length - 1].published_at || 0, videos[videos.length - 1].video_id)
    : null;

  return json(
    { playlist: p, videos, videos_next_cursor },
    200,
    { "cache-control": "public, max-age=60" }
  );
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
