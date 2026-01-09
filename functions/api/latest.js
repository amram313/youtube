export async function onRequest({ env, request }) {
  const url = new URL(request.url);

  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "24", 10), 1), 60);

  // cursor: נשתמש רק ב-id כדי לאפשר דפדוף באינדקס (INTEGER PRIMARY KEY / rowid)
  // נתמוך גם בפורמט הישן "<published_or_0>:<row_id>" כדי לא לשבור דברים קיימים.
  const cursorRaw = (url.searchParams.get("cursor") || "").trim();
  let cursorId = null;

  if (cursorRaw) {
    const parts = cursorRaw.split(":");
    const idStr = (parts.length === 2 ? parts[1] : parts[0]) || "0";
    const id = parseInt(idStr, 10);
    if (Number.isFinite(id) && id > 0) cursorId = id;
  }

  const baseSql = `
    SELECT
      v.id,
      v.video_id,
      v.title,
      v.published_at,
      c.channel_id,
      c.title AS channel_title
    FROM videos v
    JOIN channels c ON c.id = v.channel_int
  `;

  const rows = cursorId
    ? await env.DB.prepare(`
        ${baseSql}
        WHERE v.id < ?
        ORDER BY v.id DESC
        LIMIT ?
      `).bind(cursorId, limit).all()
    : await env.DB.prepare(`
        ${baseSql}
        ORDER BY v.id DESC
        LIMIT ?
      `).bind(limit).all();

  const videos = (rows.results || []).map(r => ({
    video_id: r.video_id,
    title: r.title,
    published_at: r.published_at,
    channel_id: r.channel_id,
    channel_title: r.channel_title,
  }));

  let next_cursor = null;
  const last = (rows.results || [])[rows.results.length - 1];
  if (last) {
    // cursor חדש הוא רק ה-id (הלקוח מתייחס לזה כמחרוזת אטומה)
    next_cursor = String(last.id);
  }

  return Response.json(
    { videos, next_cursor },
    { headers: { "cache-control": "public, max-age=60" } }
  );
}
