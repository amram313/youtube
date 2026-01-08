// functions/websub/youtube.js

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function canonicalTopicUrl(topic) {
  const t = (topic || "").trim();
  if (!t) return "";

  // חשוב: ביוטיוב ה-topic ה"קנוני" הוא /xml/feeds (זה מה שמופיע ב-<link rel="self">)
  // לפעמים מגיע אלינו /feeds בלי /xml, אז מנרמלים כדי שה-DB יתאים בדיוק.
  return t
    .replace("https://www.youtube.com/feeds/videos.xml", "https://www.youtube.com/xml/feeds/videos.xml")
    .replace("https://youtube.com/feeds/videos.xml", "https://www.youtube.com/xml/feeds/videos.xml");
}

function toUnixSeconds(iso) {
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function decodeXml(s) {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function matchText(s, re) {
  const m = (s || "").match(re);
  return m ? decodeXml(m[1].trim()) : null;
}

function extractEntries(xml) {
  const out = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  let m;

  while ((m = entryRe.exec(xml))) {
    const e = m[1];

    const video_id =
      matchText(e, /<yt:videoId[^>]*>([^<]+)<\/yt:videoId>/) ||
      matchText(e, /<id[^>]*>yt:video:([^<]+)<\/id>/);

    const published_at = toUnixSeconds(matchText(e, /<published[^>]*>([^<]+)<\/published>/));
    const title = matchText(e, /<title[^>]*>([^<]+)<\/title>/);

    // תיאור: יוטיוב לפעמים שם כ: <media:group><media:description>...</media:description>
    const description =
      matchText(e, /<media:description[^>]*>([\s\S]*?)<\/media:description>/) ||
      matchText(e, /<summary[^>]*>([\s\S]*?)<\/summary>/);

    // thumbnail: <media:thumbnail url="..."/>
    const thumb = matchText(e, /<media:thumbnail[^>]*url="([^"]+)"/);

    out.push({
      video_id: video_id || null,
      published_at: published_at || null,
      title: title || null,
      description: description || null,
      thumb: thumb || null
    });
  }

  return out;
}

async function sha1hex(input) {
  const buf = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const hash = await crypto.subtle.digest("SHA-1", buf);
  const u8 = new Uint8Array(hash);
  return [...u8].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha1Hex(secret, dataU8) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, dataU8);
  const u8 = new Uint8Array(sig);
  return [...u8].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function storeVideos({ env, channel_int, entries }) {
  let upserted = 0;

  for (const it of entries) {
    if (!it.video_id) continue;

    // ננרמל thumb ל-VIDEO_ID אם זה ytimg
    let thumb_video_id = null;
    if (it.thumb) {
      const m = it.thumb.match(/\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//);
      thumb_video_id = m ? m[1] : null;
    }

    await env.DB.prepare(`
      INSERT INTO videos (channel_int, video_id, published_at, title, description, thumb_video_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_int, video_id) DO UPDATE SET
        published_at = COALESCE(excluded.published_at, videos.published_at),
        title = COALESCE(excluded.title, videos.title),
        description = COALESCE(excluded.description, videos.description),
        thumb_video_id = COALESCE(excluded.thumb_video_id, videos.thumb_video_id)
    `).bind(
      channel_int,
      it.video_id,
      it.published_at,
      it.title,
      it.description,
      thumb_video_id
    ).run();

    upserted++;
  }

  return upserted;
}

export async function onRequest({ env, request }) {
  const url = new URL(request.url);

  // GET - verification
  if (request.method === "GET") {
    const mode = (url.searchParams.get("hub.mode") || "").trim();
    const topicRaw = (url.searchParams.get("hub.topic") || "").trim();
    const topic = canonicalTopicUrl(topicRaw);
    const challenge = (url.searchParams.get("hub.challenge") || "").trim();
    const verifyToken = (url.searchParams.get("hub.verify_token") || "").trim();
    const leaseSec = parseInt(url.searchParams.get("hub.lease_seconds") || "0", 10) || 0;

    if (!challenge) return new Response("missing hub.challenge", { status: 400 });
    if (!topic) return new Response("missing hub.topic", { status: 400 });

    if (!env.WEBSUB_VERIFY_TOKEN || verifyToken !== env.WEBSUB_VERIFY_TOKEN) {
      console.log("websub GET bad token", { verifyToken });
      return new Response("bad token", { status: 403 });
    }

    // הגנה: לא לאשר אימות אם לא ביקשנו subscribe לאחרונה
    const row = topic ? await env.DB.prepare(`
      SELECT last_subscribed_at
      FROM subscriptions
      WHERE topic_url=?
    `).bind(topic).first() : null;

    const t = nowSec();
    const MAX_AGE = 15 * 60; // 15 דקות
    if (!row?.last_subscribed_at || row.last_subscribed_at < (t - MAX_AGE)) {
      console.log("websub GET stale verification");
      return new Response("stale verification", { status: 403 });
    }

    if (topic && leaseSec > 0) {
      const expires = t + leaseSec;

      await env.DB.prepare(`
        UPDATE subscriptions
        SET status='active',
            lease_expires_at=?,
            last_subscribed_at=?,
            last_error=NULL
        WHERE topic_url=?
      `).bind(expires, t, topic).run();
    }

    console.log("websub GET verified", { mode, topic, leaseSec });
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }

  // POST - notifications
  if (request.method === "POST") {
    const bodyBuf = await request.arrayBuffer();
    const bodyU8 = new Uint8Array(bodyBuf);

    const topicHdrRaw = (request.headers.get("x-hub-topic") || "").trim();
    const topicHdr = canonicalTopicUrl(topicHdrRaw);
    const sigHdr = (request.headers.get("x-hub-signature") || "").trim().toLowerCase();

    console.log("websub POST hit", {
      hasSig: !!sigHdr,
      topic: topicHdr ? topicHdr.slice(0, 120) : null,
      bytes: bodyU8.length
    });

    // בדיקת חתימה (אם מוגדרת)
    if (env.WEBSUB_SECRET) {
      // header format: "sha1=..."
      const m = sigHdr.match(/^sha1=([0-9a-f]{40})$/);
      if (!m) {
        console.log("websub POST missing/invalid signature header");
        return new Response("bad signature header", { status: 403 });
      }

      const expected = await hmacSha1Hex(env.WEBSUB_SECRET, bodyU8);
      if (expected !== m[1]) {
        console.log("websub POST signature mismatch");
        return new Response("signature mismatch", { status: 403 });
      }
    }

    if (!topicHdr) {
      console.log("websub POST missing x-hub-topic");
      return new Response("missing topic", { status: 400 });
    }

    const sub = await env.DB.prepare(`
      SELECT channel_int
      FROM subscriptions
      WHERE topic_url=?
    `).bind(topicHdr).first();

    if (!sub?.channel_int) {
      console.log("websub POST unknown topic", { topicHdr: topicHdr.slice(0, 120) });
      return new Response("unknown topic", { status: 404 });
    }

    const xml = new TextDecoder().decode(bodyU8);
    const entries = extractEntries(xml);

    const upserted = await storeVideos({ env, channel_int: sub.channel_int, entries });

    const hash = await sha1hex(bodyU8);

    await env.DB.prepare(`
      INSERT INTO logs (ts, kind, channel_int, channel_id, data)
      VALUES (?, 'websub', ?, NULL, ?)
    `).bind(nowSec(), sub.channel_int, JSON.stringify({
      topic: topicHdr,
      bytes: bodyU8.length,
      hash,
      entries: entries.length,
      upserted
    })).run();

    return new Response("ok", { status: 200 });
  }

  return new Response("use GET/POST", { status: 200 });
}
