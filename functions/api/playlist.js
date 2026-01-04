export async function onRequest({ env, request }) {
  const url = new URL(request.url);
  const playlist_id = (url.searchParams.get("playlist_id") || "").trim();
  if (!playlist_id) return new Response("missing playlist_id", { status: 400 });

  const playlist = await env.DB.prepare(`
    SELECT p.playlist_id, p.title, p.thumb_video_id, p.published_at, p.item_count,
           c.channel_id, c.title AS channel_title, c.thumbnail_url
    FROM playlists p
    JOIN channels c ON c.id = p.channel_int
    WHERE p.playlist_id = ?
  `).bind(playlist_id).first();

  if (!playlist) return new Response("not found", { status: 404 });

  return Response.json({ playlist });
}
