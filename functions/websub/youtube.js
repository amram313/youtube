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

function matchText(s,re){
  const m = s.match(re);
  return m ? decodeXml(m[1].trim()) : null;
}

function extractEntries(xml){
  const out = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  let m;

  while((m = entryRe.exec(xml))){
    const e = m[1];

    const videoId = matchText(e,/<yt:videoId>([^<]+)<\/yt:videoId>/);
    if(!videoId) continue;

    const channelId = matchText(e,/<yt:channelId>([^<]+)<\/yt:channelId>/) || null;
    const title = matchText(e,/<title>([^<]+)<\/title>/) || "";
    const published = matchText(e,/<published>([^<]+)<\/published>/);

    out.push({
      videoId,
      channelId,
      title,
      published_at: toUnixSeconds(published || null)
    });
  }

  return out;
}

function extractChannelIdFromTopic(topic){
  try{
    if(!topic) return null;
    const u = new URL(topic);
    const ch = (u.searchParams.get("channel_id") || "").trim();
    return ch || null;
  }catch(_){
    // אם topic הגיע לא בפורמט URL תקין
    const m = String(topic || "").match(/channel_id=([^&\s]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
}

async function hmacSha1Hex(secret, u8){
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name:"HMAC", hash:"SHA-1" },
    false,
    ["sign"]
  );

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

  // מצפים ל: sha1=....
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
    const topic = url.searchParams.get("hub.topic") || "";
    const challenge = url.searchParams.get("hub.challenge") || "";
    const lease = parseInt(url.searchParams.get("hub.lease_seconds") || "0", 10) || 0;

    console.log("websub GET verify", { mode, hasTopic: !!topic, lease });

    if (!env.WEBSUB_VERIFY_TOKEN) {
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

    if (!env.WEBSUB_SECRET) {
      console.log("websub POST missing WEBSUB_SECRET");
      return new Response("missing WEBSUB_SECRET", { status: 500 });
    }

    // בדיקת חתימה (חובה)
    const sigHeader = request.headers.get("x-hub-signature") || "";
    const gotHex = parseSha1Signature(sigHeader);
    const expHex = await hmacSha1Hex(env.WEBSUB_SECRET, bodyU8);

    if(!gotHex || gotHex.toLowerCase() !== expHex.toLowerCase()){
      console.log("websub POST bad signature", {
        hasTopic: !!topic,
        gotPrefix: (sigHeader || "").slice(0, 12)
      });
      return new Response("bad signature", { status: 403 });
    }

    const xml = new TextDecoder().decode(bodyU8);
    const entries = extractEntries(xml);

    console.log("websub POST received", {
      hasTopic: !!topic,
      entries: entries.length
    });

    if (!entries.length) return new Response(null, { status: 204 });

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
        (entries.find(e => e.channelId)?.channelId || null);

      if (chId) {
        const ch = await env.DB.prepare(`
          SELECT id FROM channels WHERE channel_id=?
        `).bind(chId).first();

        channel_int = ch?.id ?? null;
      }
    }

    if(!channel_int){
      console.log("websub POST cannot map channel_int", { hasTopic: !!topic });
      return new Response(null, { status: 204 });
    }

    const now = nowSec();
    const stmts = [];

    for(const e of entries){
      const title = (e.title || "").slice(0,200);
      stmts.push(env.DB.prepare(`
        INSERT INTO videos(video_id, channel_int, title, published_at, updated_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          channel_int   = excluded.channel_int,
          title         = excluded.title,
          published_at  = COALESCE(excluded.published_at, videos.published_at),
          updated_at    = excluded.updated_at
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
