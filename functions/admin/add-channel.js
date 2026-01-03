// functions/admin/add-channel.js

function unauthorized() { return new Response("unauthorized", { status: 401 }); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function toUnixSeconds(iso) {
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

async function ytJson(url) {
  const r = await fetch(url);
  const t = await r.text();
  if (!r.ok) throw new Error(`YT ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

async function importPlaylistsForChannel({ env, channel_int, channel_id, max_pages = 10 }) {
  if (!env.YT_API_KEY) return { ok: false, reason: "missing YT_API_KEY", imported: 0 };

  let pageToken = null;
  let imported = 0;

  for (let page = 0; page < max_pages; page++) {
    const url =
      `https://www.googleapis.com/youtube/v3/playlists` +
      `?part=snippet,contentDetails&maxResults=50` +
      `&channelId=${encodeURIComponent(channel_id)}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ``) +
      `&key=${encodeURIComponent(env.YT_API_KEY)}`;

    const data = await ytJson(url);
    const items = data?.items || [];
    if (!items.length && !data?.nextPageToken) break;

    const stmts = [];
    const now = nowSec();

    for (const it of items) {
      const playlist_id = it?.id || null;
      const title = (it?.snippet?.title || "").slice(0, 200) || null;
      const published_at = toUnixSeconds(it?.snippet?.publishedAt || null);
      const item_count = Number.isFinite(it?.contentDetails?.itemCount)
        ? it.contentDetails.itemCount
        : null;

      if (!playlist_id) continue;

      stmts.push(
        env.DB.prepare(`
          INSERT INTO playlists(playlist_id, channel_int, title, published_at, item_count, updated_at)
          VALUES(?, ?, ?, ?, ?, ?)
          ON CONFLICT(playlist_id) DO UPDATE SET
            channel_int  = excluded.channel_int,
            title        = COALESCE(excluded.title, playlists.title),
            published_at = COALESCE(excluded.published_at, playlists.published_at),
            item_count   = COALESCE(excluded.item_count, playlists.item_count),
            updated_at   = excluded.updated_at
        `).bind(playlist_id, channel_int, title, published_at, item_count, now)
      );

      imported++;
    }

    if (stmts.length) await env.DB.batch(stmts);

    pageToken = data?.nextPageToken || null;
    if (!pageToken) break;
  }

  return { ok: true, imported };
}

/**
 * שולח subscribe ל-Hub באופן "אידמפוטנטי":
 * - אם כבר Active ויש עוד מספיק זמן עד פקיעה => לא שולח שוב
 * - אם שולח שוב, לא מוריד Active ל-Pending
 */
async function subscribeWebSub({ env, request, channel_id, channel_int }) {
  const t = nowSec();
  const origin = new URL(request.url).origin;
  const callback = `${origin}/websub/youtube`;
  const topic = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channel_id)}`;
  const hub = "https://pubsubhubbub.appspot.com/subscribe";

  const existing = await env.DB.prepare(`
    SELECT status, lease_expires_at
    FROM subscriptions
    WHERE topic_url=?
  `).bind(topic).first();

  // אם כבר פעיל ויש "מרווח" יפה עד פקיעה - לא מטרידים את ה-Hub ולא יוצרים עוד GETים/לוגים
  const MIN_REMAINING = 2 * 24 * 3600; // 2 ימים
  if (existing?.status === "active" && Number.isFinite(existing?.lease_expires_at) && existing.lease_expires_at > t + MIN_REMAINING) {
    return { ok: true, skipped: true, reason: "already active", topic, hub_status: null };
  }

  const params = new URLSearchParams();
  params.set("hub.mode", "subscribe");
  params.set("hub.callback", callback);
  params.set("hub.topic", topic);
  params.set("hub.verify", "async");
  if (env.WEBSUB_SECRET) params.set("hub.secret", env.WEBSUB_SECRET);

  const res = await fetch(hub, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const last_error = res.ok ? null : `hub subscribe failed: ${res.status}`;

  // חשוב: אם היה ACTIVE - להשאיר ACTIVE (לא להפוך ל-pending בגלל לחיצה נוספת)
  await env.DB.prepare(`
    INSERT INTO subscriptions(topic_url, channel_int, status, last_subscribed_at, last_error)
    VALUES(?, ?, 'pending', ?, ?)
    ON CONFLICT(topic_url) DO UPDATE SET
      channel_int = excluded.channel_int,
      status = CASE
        WHEN subscriptions.status='active' THEN 'active'
        ELSE 'pending'
      END,
      last_subscribed_at = excluded.last_subscribed_at,
      last_error = excluded.last_error
  `).bind(topic, channel_int, t, last_error).run();

  return { ok: res.ok, skipped: false, topic, hub_status: res.status, last_error };
}

export async function onRequest({ env, request }) {
  if (request.method !== "POST") return new Response("use POST", { status: 200 });

  const token = request.headers.get("x-admin-token") || "";
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return unauthorized();

  const body = await request.json().catch(() => ({}));
  const channel_id = (body.channel_id || "").trim();
  const playlists_pages = Math.min(Math.max(parseInt(body.playlists_pages || "10", 10), 1), 30);

  if (!channel_id) return new Response("missing channel_id", { status: 400 });

  const t = nowSec();

  let title = (body.title || "").trim() || null;
  let thumb = null;
  let uploads = null;

  if (env.YT_API_KEY) {
    const data = await ytJson(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&id=${encodeURIComponent(channel_id)}&key=${encodeURIComponent(env.YT_API_KEY)}`
    );
    const item = data?.items?.[0];
    title = item?.snippet?.title || title || null;
    thumb =
      item?.snippet?.thumbnails?.default?.url ||
      item?.snippet?.thumbnails?.medium?.url ||
      item?.snippet?.thumbnails?.high?.url ||
      null;
    uploads = item?.contentDetails?.relatedPlaylists?.uploads || null;
  }

  // channels
  await env.DB.prepare(`
    INSERT INTO channels(channel_id, title, thumbnail_url, is_active, created_at, updated_at)
    VALUES(?, ?, ?, 1, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      title = COALESCE(excluded.title, channels.title),
      thumbnail_url = COALESCE(excluded.thumbnail_url, channels.thumbnail_url),
      is_active = 1,
      updated_at = excluded.updated_at
  `).bind(channel_id, title, thumb, t, t).run();

  const ch = await env.DB.prepare(`SELECT id FROM channels WHERE channel_id=?`).bind(channel_id).first();
  if (!ch) return new Response("failed to load channel row", { status: 500 });
  const channel_int = ch.id;

  // backfill state
  await env.DB.prepare(`
    INSERT INTO channel_backfill(channel_int, uploads_playlist_id, next_page_token, done, imported_count, updated_at)
    VALUES(?, ?, NULL, 0, 0, ?)
    ON CONFLICT(channel_int) DO UPDATE SET
      uploads_playlist_id = COALESCE(excluded.uploads_playlist_id, channel_backfill.uploads_playlist_id),
      updated_at = excluded.updated_at
  `).bind(channel_int, uploads, t).run();

  // subscribe WebSub (אידמפוטנטי)
  const sub = await subscribeWebSub({ env, request, channel_id, channel_int });

  // import playlists now (כמו שהיה)
  const playlists = await importPlaylistsForChannel({
    env,
    channel_int,
    channel_id,
    max_pages: playlists_pages
  });

  return Response.json({
    ok: true,
    channel_id,
    channel_int,
    title,
    uploads_playlist_id: uploads,
    websub: sub,
    playlists
  });
}
