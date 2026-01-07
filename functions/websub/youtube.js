// functions/websub/youtube.js

function nowSec(){ return Math.floor(Date.now()/1000); }

function toUnixSeconds(iso){
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? Math.floor(ms/1000) : null;
}

function decodeXml(s){
  return (s||"")
    .replace(/&amp;/g,"&")
    .replace(/&lt;/g,"<")
    .replace(/&gt;/g,">")
    .replace(/&quot;/g,'"')
    .replace(/&#39;/g,"'");
}

function extractTag(xml, tag){
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? decodeXml(m[1].trim()) : "";
}

function extractEntries(xml){
  const entries = [];
  const re = /<entry\b[\s\S]*?<\/entry>/gi;
  let m;
  while((m = re.exec(xml))){
    const entryXml = m[0];

    const videoIdRaw =
      extractTag(entryXml, "yt:videoId") ||
      extractTag(entryXml, "videoId") ||
      "";

    const chIdRaw =
      extractTag(entryXml, "yt:channelId") ||
      extractTag(entryXml, "channelId") ||
      "";

    const titleRaw =
      extractTag(entryXml, "title") ||
      "";

    const publishedRaw =
      extractTag(entryXml, "published") ||
      extractTag(entryXml, "updated") ||
      "";

    const videoId = (videoIdRaw || "").trim();
    const channelId = (chIdRaw || "").trim();
    const title = (titleRaw || "").trim();

    const published_at = publishedRaw ? toUnixSeconds(publishedRaw) : null;

    if(videoId){
      entries.push({ videoId, channelId, title, published_at });
    }
  }
  return entries;
}

function extractChannelIdFromTopic(topic){
  const t = (topic || "").trim();
  if(!t) return "";

  try {
    const u = new URL(t);
    const ch = u.searchParams.get("channel_id") || "";
    return (ch || "").trim();
  } catch(e) {
    return "";
  }
}

function extractChannelIdFromXml(xml){
  const ch = extractTag(xml, "yt:channelId") || extractTag(xml, "channelId") || "";
  return (ch || "").trim();
}

async function hmacSha1Hex(secret, bytesU8){
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name:"HMAC", hash:"SHA-1" },
    false,
    ["sign"]
  );

  const u8 = bytesU8 instanceof Uint8Array ? bytesU8 : new Uint8Array(bytesU8);
  const sig = await crypto.subtle.sign("HMAC", key, u8);
  const b = new Uint8Array(sig);

  let hex = "";
  for(let i=0;i<b.length;i++){
    hex += b[i].toString(16).padStart(2,"0");
  }
  return hex;
}

function parseSha1Signature(headerVal){
  const s = (headerVal || "").trim();
  if(!s) return null;

  // "sha1=...."
  if(s.toLowerCase().startsWith("sha1=")){
    const hex = s.slice(5).trim();
    return hex ? hex : null;
  }

  // אם הגיע רק ההקס בלי prefix
  return s;
}

export async function onRequest({ env, request }){
  const url = new URL(request.url);

  // =========================
  // אימות GET מה-Hub
  // =========================
  if(request.method === "GET"){
    const mode = url.searchParams.get("hub.mode") || "";
    const topic = (url.searchParams.get("hub.topic") || "").trim();
    const challenge = url.searchParams.get("hub.challenge") || "";
    const lease = parseInt(url.searchParams.get("hub.lease_seconds") || "0", 10) || 0;

    if(!env.WEBSUB_VERIFY_TOKEN){
      console.log("websub GET missing WEBSUB_VERIFY_TOKEN");
      return new Response("missing WEBSUB_VERIFY_TOKEN", { status: 500 });
    }

    const verifyToken = url.searchParams.get("hub.verify_token") || "";
    if (verifyToken !== env.WEBSUB_VERIFY_TOKEN) {
      console.log("websub GET bad verify_token");
      return new Response("bad verify_token", { status: 403 });
    }

    if (!challenge) {
      return new Response("missing hub.challenge", { status: 400 });
    }

    // מאשרים אימות רק לטופיק שאנחנו מכירים (מונע אימותים זדוניים בלי לשבור renew של ה-Hub)
    if (!topic) {
      return new Response("missing hub.topic", { status: 400 });
    }

    const known = await env.DB.prepare(`
      SELECT 1
      FROM subscriptions
      WHERE topic_url=?
    `).bind(topic).first();

    if (!known) {
      console.log("websub GET unknown topic");
      return new Response("unknown topic", { status: 404 });
    }

    const t = nowSec();

    if (topic && lease > 0) {
      const expires = t + lease;

      await env.DB.prepare(`
        UPDATE subscriptions
        SET status='active',
            lease_expires_at=?,
            last_subscribed_at=?,
            last_error=NULL
        WHERE topic_url=?
      `).bind(expires, t, topic).run();
    }

    return new Response(challenge, {
      status: 200,
      headers: {
        "content-type":"text/plain; charset=utf-8",
        "cache-control":"no-store"
      }
    });
  }

  // =========================
  // התראות POST מה-Hub
  // =========================
  if (request.method === "POST") {
    const bodyBuf = await request.arrayBuffer();
    const bodyU8 = new Uint8Array(bodyBuf);

    const topic = (request.headers.get("x-hub-topic") || "").trim();

    console.log("websub POST hit", {
      hasSig: !!request.headers.get("x-hub-signature"),
      topic: topic.slice(0, 120),
      len: request.headers.get("content-length") || null
    });

    const secret = (env.WEBSUB_SECRET || "").trim();

    // אם הוגדר secret במנוי (hub.secret) - חובה לבדוק חתימה
    if (secret) {
      const sigHeader = request.headers.get("x-hub-signature") || "";
      const gotHex = parseSha1Signature(sigHeader);
      const expHex = await hmacSha1Hex(secret, bodyU8);

      if (!gotHex || gotHex.toLowerCase() !== expHex.toLowerCase()) {
        console.log("websub POST bad signature", {
          hasTopic: !!topic,
          gotPrefix: (sigHeader || "").slice(0, 12)
        });
        return new Response("bad signature", { status: 403 });
      }
    } else {
      // אם לא הוגדר secret אצלנו - ה-Hub לרוב גם לא יחתום.
      // זה פחות מאובטח, אבל מאפשר לקבל פושים במקום להיכשל תמיד.
      console.log("websub POST no WEBSUB_SECRET - signature check skipped");
    }

    const xml = new TextDecoder().decode(bodyU8);
    const entries = extractEntries(xml);

    console.log("websub POST received", {
      hasTopic: !!topic,
      entries: entries.length
    });

    // 1) נסה למפות לפי subscriptions.topic_url (הדרך הראשית)
    let channel_int = null;

    if (topic) {
      const sub = await env.DB.prepare(`
        SELECT channel_int FROM subscriptions WHERE topic_url=?
      `).bind(topic).first();

      channel_int = sub?.channel_int ?? null;
    }

    // 2) fallback: נסה לפי channel_id מתוך topic או מתוך ה-XML
    if (!channel_int) {
      const chId =
        extractChannelIdFromTopic(topic) ||
        extractChannelIdFromXml(xml) ||
        "";

      if (chId) {
        const row = await env.DB.prepare(`
          SELECT channel_int FROM channels WHERE channel_id=?
        `).bind(chId).first();

        channel_int = row?.channel_int ?? null;
      }
    }

    if (!channel_int) {
      console.log("websub POST cannot map channel", {
        topic: topic.slice(0, 120),
        sample: xml.slice(0, 160)
      });
      return new Response("cannot map channel", { status: 202 });
    }

    const now = nowSec();

    // הכנסת סרטונים למסד
    const stmts = [];
    for (const e of entries) {
      const title = (e.title || "").trim();

      stmts.push(env.DB.prepare(`
        INSERT INTO videos(video_id, channel_int, title, published_at, created_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          channel_int = excluded.channel_int,
          title = CASE
            WHEN excluded.title IS NOT NULL AND excluded.title != '' THEN excluded.title
            ELSE videos.title
          END,
          published_at = COALESCE(excluded.published_at, videos.published_at),
          created_at = COALESCE(videos.created_at, excluded.created_at)
        WHERE
          videos.channel_int IS NOT excluded.channel_int
          OR videos.title IS NOT excluded.title
          OR (excluded.published_at IS NOT NULL AND COALESCE(videos.published_at,0) != COALESCE(excluded.published_at,0))
      `).bind(e.videoId, channel_int, title, e.published_at ?? null, now));
    }

    if(stmts.length) await env.DB.batch(stmts);

    console.log("websub POST ok", { channel_int, inserted: stmts.length });

    return new Response(null, { status: 204 });
  }

  return new Response("method not allowed", { status: 405 });
}
