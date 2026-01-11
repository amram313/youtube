// functions/api/search.js
// FTS5 search on titles only (video_fts) + cursor pagination by rowid

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function cleanQuery(q) {
  const s = (q || "").trim();
  if (!s) return "";
  return s
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toFtsMatch(cleaned) {
  if (!cleaned) return "";
  const parts = cleaned.split(" ").filter(Boolean);
  if (!parts.length) return "";
  return parts.map(p => `"${p}"`).join(" ");
}

export async function onRequest({ env, request }) {
  const url = new URL(request.url);

  const qRaw = url.searchParams.get("q") || "";
  const cleaned = cleanQuery(qRaw);
  const match = toFtsMatch(cleaned);

  const limit = clamp(parseInt(url.searchParams.get("limit") || "24", 10), 1, 50);

  const cursorRaw = (url.searchParams.get("cursor") || "").trim();
  const cursor = cursorRaw ? parseInt(cursorRaw, 10) : null;

  if (!match) {
    return Response.json(
      { q: qRaw, match: "", results: [], next_cursor: null },
      { headers: { "cache-control": "no-store" } }
    );
  }

  const rows = (Number.isFinite(cursor) && cursor > 0)
    ? await env.DB.prepare(`
        SELECT rowid, video_id, title, published_at
        FROM video_fts
        WHERE video_fts MATCH ?
          AND rowid < ?
        ORDER BY rowid DESC
        LIMIT ?
      `).bind(match, cursor, limit).all()
    : await env.DB.prepare(`
        SELECT rowid, video_id, title, published_at
        FROM video_fts
        WHERE video_fts MATCH ?
        ORDER BY rowid DESC
        LIMIT ?
      `).bind(match, limit).all();

  const res = rows.results || [];

  // מחזירים גם cursor לכל פריט כדי שהלקוח יוכל להמשיך גם אם next_cursor חסר
  const results = res.map(r => ({
    video_id: r.video_id,
    title: r.title,
    published_at: r.published_at,
    cursor: String(r.rowid)
  }));

  const last = res[res.length - 1];
  const next_cursor = last ? String(last.rowid) : null;

  return Response.json(
    { q: qRaw, match, results, next_cursor },
    { headers: { "cache-control": "no-store" } }
  );
}
