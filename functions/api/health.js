export async function onRequest({ env }) {
  try {
    const r = await env.DB.prepare("SELECT 1 AS ok").first();
    return Response.json({ ok: true, db: !!r?.ok }, {
      headers: { "cache-control": "no-store" }
    });
  } catch (e) {
    return Response.json({ ok: false, db: false, error: String(e?.message || e) }, { status: 500 });
  }
}
