// functions/websub/youtube.js

function nowSec(){ return Math.floor(Date.now()/1000); }
function toUnixSeconds(iso){ const ms=Date.parse(iso||""); return Number.isFinite(ms)?Math.floor(ms/1000):null; }

function decodeXml(s){
  return (s||"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}
function matchText(s,re){ const m=s.match(re); return m?decodeXml(m[1].trim()):null; }

function extractEntries(xml){
  const out=[];
  const entryRe=/<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  let m;
  while((m=entryRe.exec(xml))){
    const body=m[1];
    const videoId = matchText(body, /<yt:videoId>([^<]+)<\/yt:videoId>/i);
    const title = matchText(body, /<title>([^<]+)<\/title>/i);
    const published = matchText(body, /<published>([^<]+)<\/published>/i);
    if (!videoId) continue;
    out.push({
      videoId,
      title: title || "",
      published_at: toUnixSeconds(published)
    });
  }
  return out;
}

// HMAC-SHA1 hex (WebSub signature)
async function hmacSha1Hex(secret, dataU8){
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, dataU8);
  const b = new Uint8Array(sig);
  let hex="";
  for (let i=0;i<b.length;i++) hex += b[i].toString(16).padStart(2,"0");
  return hex;
}

export async function onRequest({ env, request }){
  const url = new URL(request.url);

  // GET אימות (Hub -> callback)
  if (request.method === "GET") {
    const mode = url.searchParams.get("hub.mode") || "";
    const topic = url.searchParams.get("hub.topic") || "";
    const challenge = url.searchParams.get("hub.challenge") || "";
    const lease = parseInt(url.searchParams.get("hub.lease_seconds") || "0", 10) || 0;

    if (!challenge) {
      return new Response("missing hub.challenge", { status: 400 });
    }

    // לזהות channel_id מה-topic
    let channel_id = null;
    try { channel_id = new URL(topic).searchParams.get("channel_id"); } catch {}

    // קריטי: מסמנים ACTIVE גם אם lease_seconds חסר/0 (אחרת יישאר pending)
    let lease_expires_at = null;
    if (lease > 0) lease_expires_at = nowSec() + lease;

    if (topic) {
      // נעדכן subscription לפי topic_url (הכי יציב)
      // אם יש channel_id, ננסה להביא channel_int כדי לשמור (לא חובה, אבל שימושי)
      let channel_int = null;

      if (channel_id) {
        const ch = await env.DB.prepare(
          `SELECT id FROM channels WHERE channel_id=?`
        ).bind(channel_id).first();
        channel_int = ch?.id ?? null;
      }

      // עדכון/Upsert לרשומת subscription
      await env.DB.prepare(`
        INSERT INTO subscriptions(topic_url, kind, external_id, status, lease_expires_at, last_subscribed_at, last_error)
        VALUES(?, 'channel', COALESCE(?, ''), 'active', ?, ?, NULL)
        ON CONFLICT(topic_url) DO UPDATE SET
            status = 'active',
            lease_expires_at = COALESCE(excluded.lease_expires_at, subscriptions.lease_expires_at),
            last_error = NULL
      `).bind(
        topic,
        channel_id || "",
        lease_expires_at,
        nowSec()
      ).run();

      // אם יש channel_int — נעדכן אותו (אצלך יש עמודות: topic_url PRIMARY KEY, kind, external_id, status, lease_expires_at...)
      if (channel_int) {
        await env.DB.prepare(`
          UPDATE subscriptions
          SET channel_int=?
          WHERE topic_url=?
        `).bind(channel_int, topic).run().catch(()=>{});
      }
    }

    return new Response(challenge, {
      status: 200,
      headers: { "content-type":"text/plain; charset=utf-8", "cache-control":"no-store" }
    });
  }

  // POST התראות (Hub -> callback)
  if (request.method === "POST") {
    const bodyBuf = await request.arrayBuffer();
    const bodyU8 = new Uint8Array(bodyBuf);

    const topic = (request.headers.get("x-hub-topic") || request.headers.get("x-hub-topic-url") || "") || null;

    if (env.WEBSUB_SECRET) {
      const sig = request.headers.get("x-hub-signature") || "";
      const expected = "sha1=" + (await hmacSha1Hex(env.WEBSUB_SECRET, bodyU8));
      if (sig !== expected) {
        return new Response("bad signature", { status: 403 });
      }
    }

    const xml = new TextDecoder().decode(bodyU8);
    const entries = extractEntries(xml);

    if (!entries.length) return new Response(null, { status: 204 });

    // מזהים את הערוץ מתוך topic (כדי לקבל channel_int מהר)
    let channel_id = null;
    try { channel_id = topic ? new URL(topic).searchParams.get("channel_id") : null; } catch {}

    let channel_int = null;
    if (channel_id) {
      const ch = await env.DB.prepare(`SELECT id FROM channels WHERE channel_id=?`).bind(channel_id).first();
      channel_int = ch?.id ?? null;
    }

    // אם אין channel_int, ננסה דרך subscriptions (אם יש אצלך channel_int שם)
    if (!channel_int && topic) {
      try {
        const sub = await env.DB.prepare(`SELECT channel_int FROM subscriptions WHERE topic_url=?`).bind(topic).first();
        channel_int = sub?.channel_int ?? null;
      } catch {}
    }

    // אם עדיין אין — נחזיר 204 (שלא ינסה שוב) אבל לא נכתוב
    if (!channel_int) {
      return new Response(null, { status: 204 });
    }

    const now = nowSec();
    const stmts = [];

    for (const e of entries) {
      const title = (e.title || "").trim() || "ללא כותרת";
      stmts.push(
        env.DB.prepare(`
          INSERT INTO videos(video_id, channel_int, title, published_at, updated_at)
          VALUES(?, ?, ?, ?, ?)
          ON CONFLICT(video_id) DO UPDATE SET
            title         = excluded.title,
            channel_int   = excluded.channel_int,
            published_at  = COALESCE(excluded.published_at, videos.published_at),
            updated_at    = excluded.updated_at
        `).bind(e.videoId, channel_int, title, e.published_at ?? null, now)
      );
    }
    if (stmts.length) await env.DB.batch(stmts);

    return new Response(null, { status: 204 });
  }

  return new Response("method not allowed", { status: 405 });
}
