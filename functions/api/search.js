// functions/api/search.js
// חיפוש בכותרות בלבד באמצעות FTS5 (video_fts)
// דפדוף יציב לפי (published_at, video_id) כדי ש"טען עוד" לא ייתקע בגלל rowid של FTS.

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// מנקה קלט: משאיר אותיות/מספרים/רווחים בלבד (כולל עברית)
function cleanQuery(q) {
  const s = (q || "").trim();
  if (!s) return "";

  return s
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// בונה MATCH בסיסי: כל מילה עטופה ב-"..." => AND בין מילים
function toFtsMatch(cleaned) {
  if (!cleaned) return "";
  const parts = cleaned.split(" ").filter(Boolean);
  if (!parts.length) return "";
  return parts.map(p => `"${p}"`).join(" ");
}

// cursor format: "<published_at>:<video_id>"
function parseCursor(cursorRaw) {
  const s = (cursorRaw || "").trim();
  if (!s) return { p: null, vid: null };

  const idx = s.indexOf(":");
  if (idx <= 0) return { p: null, vid: null };

  const pStr = s.slice(0, idx);
  const vid = s.slice(idx + 1);

  const p = parseInt(pStr || "0", 10);
  if (!Number.isFinite(p) || !vid) return { p: null, vid: null };

  return { p, vid };
}

export async function onRequest({ env, request }) {
  const url = new URL(request.url);

  const qRaw = url.searchParams.get("q") || "";
  const cleaned = cleanQuery(qRaw);
  const match = toFtsMatch(cleaned);

  const limit = clamp(parseInt(url.searchParams.get("limit") || "24", 10), 1, 50);

  const { p: cursorP, vid: cursorVid } = parseCursor(url.searchParams.get("cursor") || "");

  if (!match) {
    return Response.json(
      { q: qRaw, match: "", results: [], next_cursor: null },
      { headers: { "cache-control": "public, max-age=30" } }
    );
  }

  // שים לב:
  // - נשארים ב-FTS בלבד (אין JOIN).
  // - CAST כדי להבטיח ש-published_at מתנהג מספרית גם אם נשמר כטקסט ב-FTS.
  // - דפדוף יציב עם (p, video_id).
  const base = `
    SELECT video_id, title, p AS published_at
    FROM (
      SELECT
        video_id,
        title,
        CAST(published_at AS INTEGER) AS p
      FROM video_fts
      WHERE video_fts MATCH ?
    )
  `;

  const rows =
    (cursorP !== null && cursorVid !== null)
      ? await env.DB.prepare(`
          ${base}
          WHERE (p, video_id) < (?, ?)
          ORDER BY p DESC, video_id DESC
          LIMIT ?
        `).bind(match, cursorP, cursorVid, limit).all()
      : await env.DB.prepare(`
          ${base}
          ORDER BY p DESC, video_id DESC
          LIMIT ?
        `).bind(match, limit).all();

  const res = rows.results || [];

  const results = res.map(r => ({
    video_id: r.video_id,
    title: r.title,
    published_at: r.published_at
  }));

  const last = res[res.length - 1];
  const next_cursor = last ? `${last.published_at}:${last.video_id}` : null;

  return Response.json(
    { q: qRaw, match, results, next_cursor },
    { headers: { "cache-control": "public, max-age=30" } }
  );
}
