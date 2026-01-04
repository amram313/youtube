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
    const e=m[1];
    const videoId = matchText(e,/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const channelId= matchText(e,/<yt:channelId>([^<]+)<\/yt:channelId>/);
    const title   = matchText(e,/<title>([^<]+)<\/title>/);
    const pubIso  = matchText(e,/<published>([^<]+)<\/published>/);
    const published_at = toUnixSeconds(pubIso);
    if(videoId && channelId && title){
      out.push({ videoId, channelId, title, published_at });
    }
  }
  return out;
}

async function hmacSha1Hex(secret, bodyU8){
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name:"HMAC", hash:"SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, bodyU8);
  return [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

function topicFromLinkHeader(linkHeader){
  if(!linkHeader) return null;
  const m = linkHeader.match(/<([^>]+)>\s*;\s*rel="?self"?/i);
  return m?m[1]:null;
}

async function logWebsubEvent(env, data, { force = false } = {}) {
  if (!force && env.WEBSUB_LOG_EVENTS !== "1") return;
  const {
    received_at,
    method,
    topic_url,
    status_code,
    error = null,
    entries_count = null,
    first_video_id = null,
  } = data;

  await env.DB.prepare(`
    INSERT INTO websub_events(received_at, method, topic_url, status_code, error, entries_count, first_video_id)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `).bind(
    received_at,
    method,
    topic_url,
    status_code,
    error,
    entries_count,
    first_video_id
  ).run();
}

export async function onRequest({ env, request }) {
  const url = new URL(request.url);

  // GET אימות (Hub -> callback)
  if (request.method === "GET") {
    const topic = url.searchParams.get("hub.topic") || "";
    const challenge = url.searchParams.get("hub.challenge") || "";
    const lease = parseInt(url.searchParams.get("hub.lease_seconds") || "0", 10) || 0;

    if (!challenge) {
      await logWebsubEvent(env, {
        received_at: nowSec(),
        method: "GET",
        topic_url: topic || null,
        status_code: 400,
        error: "missing challenge",
      }, { force: true });
      return new Response("missing hub.challenge", { status: 400 });
    }

    // לזהות channel_id מה-topic
    let channel_id = null;
    try { channel_id = new URL(topic).searchParams.get("channel_id"); } catch {}

    // קריטי: מסמנים ACTIVE גם אם lease_seconds חסר/0 (אחרת נתקעים על pending)
    if (channel_id) {
      const ch = await env.DB.prepare(`SELECT id FROM channels WHERE channel_id=? AND is_active=1`)
        .bind(channel_id).first();

      if (ch) {
        const lease_expires_at = lease > 0 ? (nowSec() + lease) : null;

        await env.DB.prepare(`
          INSERT INTO subscriptions(topic_url, channel_int, status, lease_expires_at, last_error)
          VALUES(?, ?, 'active', ?, NULL)
          ON CONFLICT(topic_url) DO UPDATE SET
            channel_int = excluded.channel_int,
            status = 'active',
            lease_expires_at = COALESCE(excluded.lease_expires_at, subscriptions.lease_expires_at),
            last_error = NULL
        `).bind(topic, ch.id, lease_expires_at).run();
      }
    }

    await logWebsubEvent(env, {
      received_at: nowSec(),
      method: "GET",
      topic_url: topic || null,
      status_code: 200,
    });

    return new Response(challenge, {
      status: 200,
      headers: { "content-type":"text/plain; charset=utf-8", "cache-control":"no-store" }
    });
  }

  // POST התראות (Hub -> callback)
  if (request.method === "POST") {
    const bodyBuf = await request.arrayBuffer();
    const bodyU8 = new Uint8Array(bodyBuf);

    const topic = topicFromLinkHeader(request.headers.get("link") || "") || null;

    if (env.WEBSUB_SECRET) {
      const sig = request.headers.get("x-hub-signature") || "";
      const expected = "sha1=" + (await hmacSha1Hex(env.WEBSUB_SECRET, bodyU8));
      if (sig !== expected) {
        await logWebsubEvent(env, {
          received_at: nowSec(),
          method: "POST",
          topic_url: topic,
          status_code: 403,
          error: "bad signature",
        }, { force: true });
        return new Response("bad signature", { status: 403 });
      }
    }

    const xml = new TextDecoder().decode(bodyU8);
    const entries = extractEntries(xml);

    await logWebsubEvent(env, {
      received_at: nowSec(),
      method: "POST",
      topic_url: topic,
      status_code: 204,
      entries_count: entries.length,
      first_video_id: entries[0]?.videoId || null,
    });

    if (!entries.length) return new Response(null, { status: 204 });

    // מזהים את הערוץ מתוך topic (כדי לקבל channel_int מהר)
    let channel_id = null;
    try { channel_id = topic ? new URL(topic).searchParams.get("channel_id") : null; } catch {}
    if (!channel_id) return new Response(null, { status: 204 });

    const ch = await env.DB.prepare(`SELECT id FROM channels WHERE channel_id=? AND is_active=1`)
      .bind(channel_id).first();
    if (!ch) return new Response(null, { status: 204 });

    const channel_int = ch.id;
    const now = nowSec();

    const stmts = [];
    for (const e of entries) {
      // רק אם זה אותו ערוץ (בטיחות)
      if (e.channelId !== channel_id) continue;

      // חיסכון במקום: לקצץ כותרת ארוכה
      const title = (e.title || "").slice(0, 200);

      stmts.push(
        env.DB.prepare(`
          INSERT INTO videos(video_id, channel_int, title, published_at, updated_at)
          VALUES(?, ?, ?, ?, ?)
          ON CONFLICT(video_id) DO UPDATE SET
            channel_int   = excluded.channel_int,
            title         = excluded.title,
            published_at  = COALESCE(excluded.published_at, videos.published_at),
            updated_at    = excluded.updated_at
          WHERE
            excluded.channel_int IS NOT videos.channel_int OR
            excluded.title IS NOT videos.title OR
            excluded.published_at IS NOT videos.published_at
        `).bind(e.videoId, channel_int, title, e.published_at ?? null, now)
      );
    }
    if (stmts.length) await env.DB.batch(stmts);

    return new Response(null, { status: 204 });
  }

  return new Response("method not allowed", { status: 405 });
}
