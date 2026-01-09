export async function onRequest({ env, request }) {
  const url = new URL(request.url);

  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") || "24", 10), 1),
    60
  );

  // cursor format: "<published_at>:<id>"
  const cursorRaw = (url.searchParams.get("cursor") || "").trim();
  let cursorP = null;
  let cursorId = null;

  if (cursorRaw) {
    const parts = cursorRaw.split(":");
    if (parts.length === 2) {
      const p = parseInt(parts[0] || "0", 10);
      const id = parseInt(parts[1] || "0", 10);
      if (Number.isFinite(p) && Number.isFinite(id) && id > 0) {
        cursorP = p;
        cursorId = id;
      }
    }
  }

  // רק videos, בלי channels בכלל (כדי לבדוק Reads נקי)
  const rows =
    (cursorP !== null && cursorId !== null)
      ? await env.DB.prepare(`
          SELECT id, video_id, title, published_at
          FROM videos
          WHERE (published_at < ? OR (published_at = ? AND id < ?))
          ORDER BY published_at DESC, id DESC
          LIMIT ?
        `).bind(cursorP, cursorP, cursorId, limit).all()
      : await env.DB.prepare(`
          SELECT id, video_id, title, published_at
          FROM videos
          ORDER BY published_at DESC, id DESC
          LIMIT ?
        `).bind(limit).all();

  const vrows = rows.results || [];

  const videos = vrows.map(r => ({
    video_id: r.video_id,
    title: r.title,
    published_at: r.published_at,

    // זמנית: בלי ערוצים (כדי לראות Reads “נקי”)
    channel_id: null,
    channel_title: null,
  }));

  let next_cursor = null;
  const last = vrows[vrows.length - 1];
  if (last) {
    const p = (last.published_at ?? 0);
    next_cursor = `${p}:${last.id}`;
  }

  return Response.json(
    { videos, next_cursor },
    { headers: { "cache-control": "public, max-age=60" } }
  );
}
