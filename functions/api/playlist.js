export async function onRequest({ env, request }) {
  const url = new URL(request.url);
  const playlist_id = (url.searchParams.get("playlist_id") || "").trim();
  if (!playlist_id) return new Response("missing playlist_id", { status: 400 });

  const playlist = await env.DB.prepare(`
    SELECT playlist_id, title, channel_id
    FROM playlists
    WHERE playlist_id = ?
  `).bind(playlist_id).first();

  if (!playlist) return new Response("not found", { status: 404 });

  const videos = await env.DB.prepare(`
    SELECT v.video_id, v.title, v.channel_id
    FROM video_playlists vp
    JOIN videos v ON v.video_id = vp.video_id
    WHERE vp.playlist_id = ?
    ORDER BY v.rowid DESC
    LIMIT 200
  `).bind(playlist_id).all();

  return Response.json({
    playlist,
    videos: videos.results
  });
}
