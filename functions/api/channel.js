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
  if (id <= 0) return { p: null, id: 0 };
  return { p, id };
}

export async function onRequest({ env, request }) {
  const url = new URL(request.url);

  const channel_id = (url.searchParams.get("channel_id") || "").trim();
  if (!channel_id) return new Response("missing channel_id", { status: 400 });

  // Optional includes (client שלך כבר שולח 0 לערוץ/פלייליסטים)
  const include_channel = url.searchParams.get("include_channel") !== "0";
  const include_playlists = url.searchParams.get("include_playlists") !== "0";
  const include_videos = url.searchParams.get("include_videos") !== "0";

  // ניסוי כמו ב-latest: נחזיר 200 בכל קריאה כדי לצמצם overhead של הרבה שאילתות
  // (הלקוח שלך שולח videos_limit=24, אנחנו מתעלמים כרגע בשביל המדידה)
  const videos_limit = 200;

  const videos_cursor_raw =
    url.searchParams.get("videos_cursor") ||
    url.searchParams.get("cursor") || "";

  const { p: cursorP, id: cursorId } = parseCursor(videos_cursor_raw);

  // כדי להשיג channel_int (ה-id הפנימי)
  // אם לא מבקשים להחזיר פרטי ערוץ/פלייליסטים, מספיק לנו רק id.
  const chRow = await env.DB.prepare(
    include_channel || include_playlists
      ? `
        SELECT id, channel_id, title, thumbnail_url
        FROM channels
        WHERE channel_id = ?
      `
      : `
        SELECT id
        FROM channels
        WHERE channel_id = ?
      `
  ).bind(channel_id).first();

  if (!chRow) return new Response("not found", { status: 404 });

  const out = {};

  // Channel info
  if (include_channel) {
    out.channel = {
      channel_id: chRow.channel_id,
      title: chRow.title,
      thumbnail_url: chRow.thumbnail_url
    };
  }

  // Playlists (כמו שהיה)
  if (include_playlists) {
    const plLimit = clamp(parseInt(url.searchParams.get("playlists_limit") || "50", 10), 1, 200);
    const pls = await env.DB.prepare(`
      SELECT playlist_id, title, thumb_video_id, published_at, item_count
      FROM playlists
      WHERE channel_int = ?
      ORDER BY id DESC
      LIMIT ?
    `).bind(chRow.id, plLimit).all();

    out.playlists = pls.results || [];
  }

  // Videos pagination (העיקר)
  if (include_videos) {
    const vids =
      (cursorP !== null && cursorId > 0)
        ? await env.DB.prepare(`
            SELECT id, video_id, title, published_at
            FROM videos INDEXED BY idx_videos_channel_cover
            WHERE channel_int = ?
              AND (published_at, id) < (?, ?)
            ORDER BY published_at DESC, id DESC
            LIMIT ?
          `).bind(chRow.id, cursorP, cursorId, videos_limit).all()
        : await env.DB.prepare(`
            SELECT id, video_id, title, published_at
            FROM videos INDEXED BY idx_videos_channel_cover
            WHERE channel_int = ?
            ORDER BY published_at DESC, id DESC
            LIMIT ?
          `).bind(chRow.id, videos_limit).all();

    const rows = vids.results || [];

    out.videos = rows.map(r => ({
      video_id: r.video_id,
      title: r.title,
      published_at: r.published_at
    }));

    const last = rows[rows.length - 1];
    out.videos_next_cursor = last ? `${(last.published_at ?? 0)}:${last.id}` : null;
  }

  return Response.json(out, {
    headers: {
      "cache-control": "public, max-age=30"
    }
  });
}
