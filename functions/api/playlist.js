function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function clamp(n, a, b) {
  n = parseInt(n, 10);
  if (!Number.isFinite(n)) n = a;
  return Math.max(a, Math.min(b, n));
}

// cursor format: "<published_at_or_0>:<video_id>"
function parseCursor(raw) {
  const s = (raw || "").trim();
  if (!s) return null;
  const i = s.indexOf(":");
  if (i === -1) return null;
  const ts = parseInt(s.slice(0, i), 10);
  const vid = s.slice(i + 1);
  if (!Number.isFinite(ts) || !vid) return null;
  return { ts, vid };
}

function makeCursor(ts, vid) {
  return `${ts || 0}:${vid}`;
}

export async function onRequest({ env, request }) {
  try {
    const url = new URL(request.url);

    const playlist_id = (url.searchParams.get("playlist_id") || "").trim();
    if (!playlist_id) return json({ ok: false, error: "missing playlist_id" }, 400);

    const videos_limit = clamp(url.searchParams.get("videos_limit") || url.searchParams.get("limit") || "24", 1, 60);
    const cursorRaw =
      url.searchParams.get("videos_cursor") ||
      url.searchParams.get("cursor") ||
      "";
    const cur = parseCursor(cursorRaw);

    // 1) playlist meta
    const playlist = await env.DB.prepare(`
      SELECT
        p.playlist_id,
        p.title,
        p.thumb_video_id,
        p.published_at,
        p.item_count,
        c.channel_id,
        c.title AS channel_title,
        c.thumbnail_url AS channel_thumbnail_url
      FROM playlists p
      JOIN channels c ON c.id = p.channel_int
      WHERE p.playlist_id = ?
      LIMIT 1
    `).bind(playlist_id).first();

    if (!playlist) return json({ ok: true, playlist: null, videos: [], videos_next_cursor: null }, 404);

    // 2) playlist videos (pagination)
    const where = cur
      ? `AND (
            COALESCE(v.published_at, 0) < ?
            OR (COALESCE(v.published_at, 0) = ? AND v.video_id < ?)
         )`
      : "";

    const binds = cur
      ? [playlist_id, cur.ts, cur.ts, cur.vid, videos_limit]
      : [playlist_id, videos_limit];

    const rows = await env.DB.prepare(`
      SELECT
        v.video_id,
        v.title,
        v.published_at,
        c.channel_id,
        c.title AS channel_title,
        c.thumbnail_url AS channel_thumbnail_url
      FROM playlist_videos pv
      JOIN videos v ON v.video_id = pv.video_id
      JOIN channels c ON c.id = v.channel_int
      WHERE pv.playlist_id = ?
      ${where}
      ORDER BY COALESCE(v.published_at, 0) DESC, v.video_id DESC
      LIMIT ?
    `).bind(...binds).all();

    const videos = rows.results || [];

    const last = videos[videos.length - 1];
    const videos_next_cursor =
      videos.length === videos_limit && last
        ? makeCursor(last.published_at || 0, last.video_id)
        : null;

    return json(
      { ok: true, playlist, videos, videos_next_cursor },
      200,
      { "cache-control": "public, max-age=30" }
    );
  } catch (e) {
    return json(
      { ok: false, error: "exception", message: String(e?.message || e) },
      500
    );
  }
}
