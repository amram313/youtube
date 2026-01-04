function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// cursor format: "<published_or_0>:<row_id>"
function parseCursor(raw) {
  const s = (raw || "").trim();
  if (!s) return { p: null, id: 0 };
  const [pStr, idStr] = s.split(":");
  const p = parseInt(pStr || "0", 10);
  const id = parseInt(idStr || "0", 10);
  if (Number.isNaN(p) || Number.isNaN(id)) return { p: null, id: 0 };
  return { p, id };
}

export async function onRequest({ env, request }) {
  const url = new URL(request.url);
  const channel_id = (url.searchParams.get("channel_id") || "").trim();
  if (!channel_id) return new Response("missing channel_id", { status: 400 });

  // Optional includes (for future optimizations; default keep old behavior)
  const include_channel = url.searchParams.get("include_channel") !== "0";
  const include_playlists = url.searchParams.get("include_playlists") !== "0";
  const include_videos = url.searchParams.get("include_videos") !== "0";

  // Backward compatible: if client doesn't send limit, keep it fairly large
  const videos_limit = clamp(parseInt(url.searchParams.get("videos_limit") || "60", 10), 1, 100);
  const videos_cursor_raw =
    url.searchParams.get("videos_cursor") ||
    url.searchParams.get("cursor") || "";

  const { p: cursorP, id: cursorId } = parseCursor(videos_cursor_raw);

  // Always need channel row to get internal id
  const chRow = await env.DB.prepare(`
    SELECT id, channel_id, title, thumbnail_url
    FROM channels
    WHERE channel_id = ?
  `).bind(channel_id).first();

  if (!chRow) return new Response("not found", { status: 404 });

  const out = {};

  if (include_channel) {
    out.channel = {
      id: chRow.id,
      channel_id: chRow.channel_id,
      title: chRow.title,
      thumbnail_url: chRow.thumbnail_url,
    };
  }

  // Playlists (no pagination yet; keep simple)
  if (include_playlists) {
    const plLimit = clamp(parseInt(url.searchParams.get("playlists_limit") || "200", 10), 1, 400);

    const pls = await env.DB.prepare(`
      SELECT playlist_id, title, thumb_video_id, published_at, item_count
      FROM playlists
      WHERE channel_int = ?
      ORDER BY id DESC
      LIMIT ?
    `).bind(chRow.id, plLimit).all();

    out.playlists = pls.results || [];
  }

  // Videos pagination
  if (include_videos) {
    const vids = await env.DB.prepare(`
      SELECT id, video_id, title, published_at
      FROM videos
      WHERE channel_int = ?
        AND (
          ? IS NULL
          OR COALESCE(published_at, 0) < ?
          OR (COALESCE(published_at, 0) = ? AND id < ?)
        )
      ORDER BY COALESCE(published_at, 0) DESC, id DESC
      LIMIT ?
    `).bind(
      chRow.id,
      cursorP,
      cursorP,
      cursorP,
      cursorId,
      videos_limit
    ).all();

    out.videos = (vids.results || []).map(r => ({
      video_id: r.video_id,
      title: r.title,
      published_at: r.published_at,
    }));

    // next cursor
    const last = (vids.results || [])[vids.results.length - 1];
    out.videos_next_cursor = last ? `${(last.published_at ?? 0)}:${last.id}` : null;
  }

  return Response.json(out, {
    headers: {
      // קצר כדי לא "להיתקע" על תוצאות ישנות
      "cache-control": "public, max-age=30"
    }
  });
}
