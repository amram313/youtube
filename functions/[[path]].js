export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // רק דפי HTML
  if (request.method !== "GET") return env.ASSETS.fetch(request);
  const accept = request.headers.get("Accept") || "";
  if (!accept.includes("text/html")) return env.ASSETS.fetch(request);

  const path = url.pathname; // כולל /

  // לא לגעת ב-API וקבצים סטטיים
  if (path.startsWith("/api/")) return env.ASSETS.fetch(request);
  if (path.includes(".")) return env.ASSETS.fetch(request); // /assets/*.js, favicon וכו'

  // תמיד נשרת את ה-SPA (index.html) כדי שרענון לא ייפול ל-404
  const indexRes = await env.ASSETS.fetch(new Request(new URL("/", url), request));

  // נחלץ מטא רק אם זה סרטון/ערוץ/פלייליסט
  const meta = await buildOgMeta(url);

  // אם לא זיהינו - מחזירים index רגיל בלי הזרקות
  if (!meta) return indexRes;

  return new HTMLRewriter()
    .on("head", {
      element(el) {
        el.append(
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
}

async function buildOgMeta(url) {
  const p = url.pathname;

  // 1) סרטון אצלך: /<11chars>
  const mVideo = p.match(/^\/([A-Za-z0-9_-]{11})$/);
  if (mVideo) {
    const id = mVideo[1];
    return await fromYouTubeOEmbed({
      pageUrl: url.toString(),
      oembedUrl: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${id}`
      )}`,
      fallbackImage: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      type: "video.other",
      fallbackDescription: "צפה בסרטון",
    });
  }

  // 2) ערוץ: /channel/<id>  (UC...)
  const mChannel = p.match(/^\/channel\/([^/]+)$/);
  if (mChannel) {
    const ch = mChannel[1];
    return await fromYouTubeOEmbed({
      pageUrl: url.toString(),
      oembedUrl: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
        `https://www.youtube.com/channel/${ch}`
      )}`,
      // אין תמונת fallback טובה לערוץ בלי API, אז נשים משהו כללי
      fallbackImage: `${url.origin}/default-og.jpg`,
      type: "website",
      fallbackDescription: "צפה בערוץ",
    });
  }

  // 3) פלייליסט: /playlist/<id>  או /playlist?list=PL...
  // אצלך ציינת "דפי פלייליסטים" - תפסתי גם וגם.
  const mPlaylist1 = p.match(/^\/playlist\/([^/]+)$/);
  const list = mPlaylist1 ? mPlaylist1[1] : url.searchParams.get("list");

  if (list && (p.startsWith("/playlist") || p.startsWith("/playlist/"))) {
    return await fromYouTubeOEmbed({
      pageUrl: url.toString(),
      oembedUrl: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
        `https://www.youtube.com/playlist?list=${list}`
      )}`,
      fallbackImage: `${url.origin}/default-og.jpg`,
      type: "website",
      fallbackDescription: "צפה בפלייליסט",
    });
  }

  // אם יש אצלך נתיבים אחרים לערוצים (למשל /@handle או /c/xyz) תגיד לי ואוסיף 2 שורות התאמה.
  return null;
}

async function fromYouTubeOEmbed({
  pageUrl,
  oembedUrl,
  fallbackImage,
  type,
  fallbackDescription,
}) {
  let title = "צפייה";
  let image = fallbackImage;
  let description = fallbackDescription;

  try {
    const r = await fetch(oembedUrl, { headers: { Accept: "application/json" } });
    if (r.ok) {
      const j = await r.json();
      title = j.title || title;
      image = j.thumbnail_url || image;
      if (j.author_name) description = `ערוץ: ${j.author_name}`;
    }
  } catch {}

  return { url: pageUrl, title, description, image, type };
}

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
