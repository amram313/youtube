export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // רק GET
  if (request.method !== "GET") return env.ASSETS.fetch(request);

  // אל תיגע ב-API ובקבצים סטטיים
  if (path.startsWith("/api/")) return env.ASSETS.fetch(request);
  if (path.includes(".")) return env.ASSETS.fetch(request); // assets, favicon וכו'

  // תמיד תחזיר SPA (index.html) כדי שרענון/שיתוף לא יפלו ל-404
  const indexRes = await env.ASSETS.fetch(new Request(new URL("/", url), request));

  // נסה לבנות OG לפי סוג הדף
  const meta = await buildOgMeta({ url, env });

  // אם לא זיהינו משהו - תחזיר index רגיל
  if (!meta) return indexRes;

  // חשוב: PREPEND כדי שיהיה בתחילת ה-head (וואטסאפ לפעמים מפספס דברים מאוחר מדי)
  const rewritten = new HTMLRewriter()
    .on("head", {
      element(el) {
        el.prepend(
          `
<meta property="og:type" content="${esc(meta.type)}">
<meta property="og:site_name" content="YouTube">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:image" content="${esc(meta.image)}">
<meta property="og:url" content="${esc(meta.url)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(meta.title)}">
<meta name="twitter:description" content="${esc(meta.description)}">
<meta name="twitter:image" content="${esc(meta.image)}">
          `.trim(),
          { html: true }
        );
      },
    })
    .transform(indexRes);

  // קאש קטן כדי שסורקים לא יפוצצו בקשות
  const out = new Response(rewritten.body, rewritten);
  out.headers.set("Cache-Control", "public, max-age=300");
  return out;
}

async function buildOgMeta({ url, env }) {
  const p = url.pathname;

  // 1) וידאו: /<11chars>
  const mVideo = p.match(/^\/([A-Za-z0-9_-]{11})$/);
  if (mVideo) {
    const id = mVideo[1];

    // אם יש לך טבלת videos אפשר לשדרג לכותרת אמיתית, כרגע fallback עובד:
    return {
      type: "video.other",
      url: url.toString(),
      title: "צפייה בסרטון",
      description: "צפה בסרטון",
      image: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  }

  // 2) פלייליסט: /PL....
  const mPl = p.match(/^\/(PL[A-Za-z0-9_-]+)$/);
  if (mPl) {
    const playlistId = mPl[1];

    const row = await firstRow(env.DB, `
      SELECT title, thumb_video_id
      FROM playlists
      WHERE playlist_id = ?
      LIMIT 1
    `, [playlistId]);

    const title = row?.title || "פלייליסט";
    const thumbVideoId = row?.thumb_video_id || "";
    const image = thumbVideoId
      ? `https://i.ytimg.com/vi/${thumbVideoId}/hqdefault.jpg`
      : `${url.origin}/default-og.jpg`;

    return {
      type: "website",
      url: url.toString(),
      title,
      description: "צפה בפלייליסט",
      image,
    };
  }

  // 3) ערוץ: /UC... וגם /UC.../videos
  const mCh = p.match(/^\/(UC[A-Za-z0-9_-]{10,})(?:\/[^/]*)?$/);
  if (mCh) {
    const channelId = mCh[1];

    const row = await firstRow(env.DB, `
      SELECT title, thumbnail_url
      FROM channels
      WHERE channel_id = ?
      LIMIT 1
    `, [channelId]);

    const title = row?.title || "ערוץ";
    const image = normalizeUrl(row?.thumbnail_url, url.origin) || `${url.origin}/default-og.jpg`;

    return {
      type: "website",
      url: url.toString(),
      title,
      description: "צפה בערוץ",
      image,
    };
  }

  return null;
}

async function firstRow(DB, sql, params) {
  // אם ה-binding אצלך לא נקרא DB, החלף פה את env.DB
  if (!DB) return null;
  const res = await DB.prepare(sql).bind(...params).all();
  return res?.results?.[0] || null;
}

function normalizeUrl(u, origin) {
  if (!u) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return origin + u;
  return u;
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
