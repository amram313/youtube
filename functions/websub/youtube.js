// functions/websub/youtube.js

function nowSec() {
  return Math.floor(Date.now() / 1000);
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

function toUnixSeconds(iso) {
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function extractEntries(xml) {
  const out = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml))) {
    const e = m[1];
    const videoId = matchText(e, /<yt:videoId>([^<]+)<\/yt:videoId>/);
    if (!videoId) continue;

    const title = matchText(e, /<title>([^<]+)<\/title>/) || "";
    const published = matchText(e, /<published>([^<]+)<\/published>/);

    out.push({
      videoId,
      title,
      published_at: toUnixSeconds(published || null),
    });
  }
  return out;
}

function channelIdFromTopic(topic) {
  const t = (topic || "").trim();
  const m = t.match(/[?&]channel_id=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function channelIdFromXml(xml) {
  const c1 = matchText(xml, /<yt:channelId>([^<]+)<\/yt:channelId>/);
  if (c1) return c1;

  const m = (xml || "").match(
    /https?:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=([A-Za-z0-9_-]+)/
  );
  return m ? m[1] : null;
}

async function sha1HmacHex(secret, bodyU8) {
  const enc = new TextEncoder();
  const keyData = enc.encode(secret);

  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );

  const sigBuf = await crypto.subtle.sign("HMAC", key, bodyU8);
  const sigU8 = new Uint8Array(sigBuf);

  let hex = "";
  for (const b of sigU8) hex += b.toString(16).padStart(2, "0");
  return hex;
}

async function findChannelIntByChannelId(env, channelId) {
  if (!channelId) return null;
  const r = await env.DB.prepare(
    `SELECT id FROM channels WHERE channel_id=? LIMIT 1`
  ).bind(channelId).first();
  return r?.id ?? null;
}

async function findChannelIntForPost(env, topicHdr, xml) {
  // 1) קודם לפי subscriptions (אם כבר קיים)
  if (topicHdr) {
    const sub = await env.DB.prepare(
      `SELECT channel_int FROM subscriptions WHERE topic_url=? LIMIT 1`
    ).bind(topicHdr).first();
    if (sub?.channel_int) {
      return { channelInt: sub.channel_int, channelId: channelIdFromTopic(topicHdr) || null };
    }
  }

  // 2) fallback לפי channels.channel_id (מחלצים מה-topic או מה-XML)
  const channelId = channelIdFromTopic(topicHdr) || channelIdFromXml(xml);
  const channelInt = await findChannelIntByChannelId(env, channelId);
  return { channelInt, channelId };
}

export async function onRequest({ env, request }) {
  const url = new URL(request.url);
  const debug = (url.searchParams.get("debug") || "") === "1";

  // =========================
  // אימות GET מה-Hub (challenge)
  // =========================
  if (request.method === "GET") {
    const topic = (url.searchParams.get("hub.topic") || "").trim();
    const challenge = url.searchParams.get("hub.challenge");
    const token = (url.searchParams.get("hub.verify_token") || "").trim();
    const leaseSec = parseInt(url.searchParams.get("hub.lease_seconds") || "0", 10) || 0;

    if (!challenge) return new Response("missing challenge", { status: 400 });
    if (!env.WEBSUB_VERIFY_TOKEN) return new Response("missing WEBSUB_VERIFY_TOKEN", { status: 500 });
    if (token !== env.WEBSUB_VERIFY_TOKEN) return new Response("bad verify_token", { status: 403 });

    const now = nowSec();
    const leaseExp = leaseSec ? (now + leaseSec) : null;

    // חשוב: subscriptions.channel_int אצלך NOT NULL
    // לכן אנחנו מחפשים channel_int לפי channel_id שב-topic, כדי שנוכל לעשות INSERT/UPSERT בלי להיכשל.
    const channelId = channelIdFromTopic(topic);
    const channelInt = await findChannelIntByChannelId(env, channelId);

    if (topic) {
      if (channelInt) {
        await env.DB.prepare(`
          INSERT INTO subscriptions(topic_url, channel_int, status, lease_expires_at, last_subscribed_at, last_error)
          VALUES(?, ?, 'active', ?, ?, NULL)
          ON CONFLICT(topic_url) DO UPDATE SET
            channel_int = excluded.channel_int,
            status = 'active',
            lease_expires_at = excluded.lease_expires_at,
            last_error = NULL
        `).bind(topic, channelInt, leaseExp, now).run();
      } else {
        // אם לא מצאנו channel_int — לא עושים INSERT כדי לא להפיל verification.
        // (עדיין מחזירים challenge כדי שה-Hub יחשב את זה כ-verified)
        console.log("websub GET verified but channel_int not found", {
          topic: (topic || "").slice(0, 140),
          channelId: channelId || null,
        });

        // ננסה לפחות UPDATE (אם כבר קיימת שורה)
        await env.DB.prepare(`
          UPDATE subscriptions
          SET status='active', lease_expires_at=?, last_error=NULL
          WHERE topic_url=?
        `).bind(leaseExp, topic).run();
      }
    }

    console.log("websub GET verified", {
      topic: (topic || "").slice(0, 140),
      channelId: channelId || null,
      channelInt: channelInt || null,
      leaseSec,
    });

    return new Response(challenge, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // =========================
  // POST מה-Hub (ההתראות בפועל)
  // =========================
  if (request.method === "POST") {
    const bodyBuf = await request.arrayBuffer();
    const bodyU8 = new Uint8Array(bodyBuf);

    const sigHdr = (request.headers.get("x-hub-signature") || "").trim();
    const topicHdr = (request.headers.get("x-hub-topic") || "").trim();

    console.log("websub POST hit", {
      hasSig: !!sigHdr,
      topic: (topicHdr || "").slice(0, 140),
      len: bodyU8.byteLength,
    });

    if (!env.WEBSUB_SECRET) {
      console.log("websub POST missing WEBSUB_SECRET");
      return new Response("missing WEBSUB_SECRET", { status: 500 });
    }

    // אימות חתימה
    const m = sigHdr.match(/^sha1=([0-9a-f]{40})$/i);
    if (!m) return new Response("bad signature", { status: 403 });

    const got = m[1].toLowerCase();
    const exp = await sha1HmacHex(env.WEBSUB_SECRET, bodyU8);
    if (got !== exp) return new Response("bad signature", { status: 403 });

    const xml = new TextDecoder("utf-8").decode(bodyU8);
    const entries = extractEntries(xml);

    const { channelInt, channelId } = await findChannelIntForPost(env, topicHdr, xml);

    if (!channelInt) {
      console.log("websub POST: no channel_int", {
        channelId: channelId || null,
        topic: (topicHdr || "").slice(0, 140),
        entries: entries.length,
      });

      if (debug) {
        return Response.json(
          { ok: false, reason: "no channel_int", channelId: channelId || null, topic: topicHdr || null, entries: entries.length },
          { status: 200 }
        );
      }

      // 204 כדי לא לגרום ריטריי אינסופי מה-Hub
      return new Response(null, { status: 204 });
    }

    const now = nowSec();

    const stmts = entries.map((e) =>
      env.DB.prepare(`
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
      `).bind(
        e.videoId,
        channelInt,
        (e.title || "").slice(0, 200),
        e.published_at ?? null,
        now
      )
    );

    if (stmts.length) await env.DB.batch(stmts);

    console.log("websub POST saved", {
      channelInt,
      entries: entries.length,
      first: entries[0]?.videoId || null,
    });

    if (debug) {
      return Response.json(
        {
          ok: true,
          channelInt,
          channelId: channelId || null,
          topic: topicHdr || null,
          entries: entries.length,
          first: entries[0]?.videoId || null,
        },
        { status: 200 }
      );
    }

    return new Response(null, { status: 204 });
  }

  return new Response("method not allowed", { status: 405 });
}
