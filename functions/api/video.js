export async function onRequest({ env, request }) {
  const url = new URL(request.url);
  const video_id = (url.searchParams.get("video_id") || "").trim();
  if (!video_id) return new Response("missing video_id", { status: 400 });

  const video = await env.DB.prepare(`
    SELECT v.video_id, v.title, v.published_at,
           c.channel_id, c.title AS channel_title, c.thumbnail_url
    FROM videos v
    JOIN channels c ON c.id = v.channel_int
    WHERE v.video_id = ?
  `).bind(video_id).first();

  if (!video) return new Response("not found", { status: 404 });

  const recommended = await env.DB.prepare(`
    SELECT v2.video_id, v2.title, v2.published_at
    FROM videos v2
    WHERE v2.channel_int = (SELECT channel_int FROM videos WHERE video_id = ?)
      AND v2.video_id <> ?
    ORDER BY (v2.published_at IS NULL), v2.published_at DESC, v2.id DESC
    LIMIT 20
  `).bind(video_id, video_id).all();

  return Response.json({
    video,
    recommended: recommended.results
  });
}
