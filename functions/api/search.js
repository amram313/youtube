function buildFtsQuery(q) {
  const cleaned = (q || "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim();
  if (!cleaned) return null;

  const tokens = cleaned.split(/\s+/).slice(0, 6);
  // prefix search לכל טוקן: "abc"*
  return tokens.map(t => `"${t.replace(/"/g, '""')}"*`).join(" AND ");
}

export async function onRequest({ env, request }) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const channel_id = (url.searchParams.get("channel_id") || "").trim();
  const fts = buildFtsQuery(q);
  if (!fts) return Response.json({ q, results: [] });

  let where = `video_fts MATCH ?`;
  const params = [fts];

  if (channel_id) {
    where += ` AND c.channel_id = ?`;
    params.push(channel_id);
  }

  const stmt = env.DB.prepare(`
    SELECT v.video_id, v.title, v.published_at,
           c.channel_id, c.title AS channel_title
    FROM video_fts f
    JOIN videos v ON v.id = f.rowid
    JOIN channels c ON c.id = v.channel_int
    WHERE ${where}
    ORDER BY (v.published_at IS NULL), v.published_at DESC, v.id DESC
    LIMIT 50
  `);

  const res = await stmt.bind(...params).all();
  return Response.json({ q, channel_id: channel_id || null, results: res.results });
}
