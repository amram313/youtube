// functions/api/channel.js

export async function onRequest({ env, request }) {
  const url = new URL(request.url);
  const channel_id = (url.searchParams.get("channel_id") || "").trim();
  if (!channel_id) return new Response("missing channel_id", { status: 400 });

  const ch = await env.DB.prepare(`
    SELECT id, channel_id, title, thumbnail_url
    FROM channels
    WHERE channel_id=? AND is_active=1
  `).bind(channel_id).first();

  if (!ch) return new Response("not found", { status: 404 });

  const backfill = await env.DB.prepare(`
    SELECT done, imported_count, updated_at
    FROM channel_backfill
    WHERE channel_int=?
  `).bind(ch.id).first();

  const playlists = await env.DB.prepare(`
    SELECT playlist_id, title, thumb_video_id, published_at, item_count
    FROM playlists
    WHERE channel_int=?
    ORDER BY (published_at IS NULL), published_at DESC, id DESC
    LIMIT 200
  `).bind(ch.id).all();

  const videos = await env.DB.prepare(`
    SELECT video_id, title, published_at
    FROM videos
    WHERE channel_int=?
    ORDER BY (published_at IS NULL), published_at DESC, id DESC
    LIMIT 50
  `).bind(ch.id).all();

  return Response.json({
    channel: ch,
    backfill: backfill || null,
    playlists: playlists.results,
    videos: videos.results
  });
}
