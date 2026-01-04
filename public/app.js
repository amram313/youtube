const $ = (id) => document.getElementById(id);

function esc(s){return (s||"").replace(/[&<>"']/g,c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]))}
function fmtDate(unix){
  if(!unix) return "";
  try { return new Date(unix*1000).toLocaleDateString('he-IL', { year:'numeric', month:'2-digit', day:'2-digit' }); }
  catch { return ""; }
}
function ytVideoThumb(videoId, q="mqdefault"){ return videoId ? `https://i.ytimg.com/vi/${videoId}/${q}.jpg` : ""; }

async function api(url){
  const r = await fetch(url);
  const t = await r.text();
  if(!r.ok) throw new Error(`${r.status} ${t.slice(0,200)}`);
  return JSON.parse(t);
}

function setPage(inner){
  $("page").innerHTML = `<div class="pad">${inner}</div>`;
}

function navigate(path){
  history.pushState({}, "", path);
  render().catch(showErr);
}

function hookLinks(){
  document.addEventListener("click", (e)=>{
    const a = e.target.closest("a");
    if(!a) return;
    const href = a.getAttribute("href") || "";
    const target = a.getAttribute("target");
    if(target === "_blank") return;
    if(!href.startsWith("/")) return;
    if(!a.hasAttribute("data-link")) return;
    e.preventDefault();
    navigate(href);
  });
}

window.addEventListener("popstate", ()=>render().catch(showErr));

function route(){
  const p = location.pathname.replace(/\/+$/,"") || "/";
  const parts = p.split("/").filter(Boolean);
  const qs = new URLSearchParams(location.search);
  return { p, parts, qs };
}

function showErr(err){
  setPage(`<div class="h1">שגיאה</div><p class="sub">${esc(err?.message || String(err))}</p>`);
}

function headerSearch(){
  const form = $("searchForm");
  const input = $("searchInput");
  if (!form || !input) return;
  form.onsubmit = (e)=>{
    e.preventDefault();
    const q = (input.value||"").trim();
    if(!q) return;
    navigate(`/search?q=${encodeURIComponent(q)}`);
  };
}

function renderVideoCard(v){
  const thumb = ytVideoThumb(v.video_id);
  const d = fmtDate(v.published_at);
  return `
    <a class="card" href="/${encodeURIComponent(v.video_id)}" data-link>
      <img class="thumb16x9" loading="lazy" decoding="async" src="${esc(thumb)}">
      <div class="cardBody">
        <div class="cardTitle">${esc(v.title || v.video_id)}</div>
        <div class="cardMeta">
          ${v.channel_title || v.channel_id ? `<span>${esc(v.channel_title || v.channel_id)}</span>` : ``}
          ${d ? `<span>${esc(d)}</span>` : ``}
        </div>
      </div>
    </a>
  `;
}

/* ---------- HOME: Load more ---------- */
let homeState = { cursor: null, loading: false, done: false, token: 0 };

async function pageHome(){
  homeState = { cursor: null, loading: false, done: false, token: homeState.token + 1 };
  const t = homeState.token;

  setPage(`
    <div class="h1">בית</div>
    <p class="sub">הסרטונים האחרונים מכל הערוצים</p>
    <div class="hr"></div>

    <div id="homeGrid" class="grid"></div>

    <div class="btnRow" style="margin-top:14px">
      <button id="homeMoreBtn" class="btn" type="button">טען עוד</button>
    </div>

    <div id="homeHint" class="muted" style="margin-top:8px"></div>
  `);

  const btn = document.getElementById("homeMoreBtn");
  btn.onclick = () => homeLoadMore(t);

  await homeLoadMore(t);
}

async function homeLoadMore(token){
  if (homeState.loading || homeState.done) return;
  homeState.loading = true;

  const btn = document.getElementById("homeMoreBtn");
  const hint = document.getElementById("homeHint");
  const grid = document.getElementById("homeGrid");

  btn.disabled = true;
  hint.textContent = "טוען…";

  const url = `/api/latest?limit=24${homeState.cursor ? `&cursor=${encodeURIComponent(homeState.cursor)}` : ""}`;
  const data = await api(url);

  if (token !== homeState.token) return;

  const vids = data.videos || [];
  if (vids.length) {
    grid.insertAdjacentHTML("beforeend", vids.map(renderVideoCard).join(""));
  }

  homeState.cursor = data.next_cursor || null;
  homeState.done = !homeState.cursor || vids.length === 0;

  btn.disabled = false;
  btn.style.display = homeState.done ? "none" : "inline-flex";
  hint.textContent = homeState.done ? "סוף הרשימה." : "";

  homeState.loading = false;
}

/* ---------- PAGES: channels list ---------- */
async function pageChannels(){
  setPage(`<div class="muted">טוען ערוצים…</div>`);
  const data = await api(`/api/channels`);
  const channels = data.channels || [];

  setPage(`
    <div class="h1">ערוצים</div>
    <p class="sub">כל הערוצים במערכת</p>
    <div class="hr"></div>

    ${channels.length ? `
      <div class="grid">
        ${channels.map(ch=>`
          <a class="card" href="/${encodeURIComponent(ch.channel_id)}/videos" data-link>
            <div class="cardBody avatarRow">
              ${ch.thumbnail_url ? `<img class="avatar" loading="lazy" decoding="async" src="${esc(ch.thumbnail_url)}" onerror="this.style.display='none'">`
                                 : `<div class="avatar"></div>`}
              <div style="min-width:0">
                <div class="cardTitle" style="margin:0">${esc(ch.title || ch.channel_id)}</div>
                <div class="cardMeta">${esc(ch.channel_id)}</div>
              </div>
            </div>
          </a>
        `).join("")}
      </div>
    ` : `<div class="muted">אין ערוצים עדיין.</div>`}
  `);
}

/* ---------- PAGES: playlists list ---------- */
async function pagePlaylists(){
  setPage(`<div class="muted">טוען פלייליסטים…</div>`);
  const data = await api(`/api/playlists?limit=60`);
  const playlists = data.playlists || [];

  setPage(`
    <div class="h1">פלייליסטים</div>
    <p class="sub">רשימת פלייליסטים מכל הערוצים</p>
    <div class="hr"></div>

    ${playlists.length ? `
      <div class="grid">
        ${playlists.map(p=>`
          <a class="card" href="/${encodeURIComponent(p.playlist_id)}" data-link>
            <img class="thumb16x9" loading="lazy" decoding="async"
                 src="${esc(p.thumb_video_id ? ytVideoThumb(p.thumb_video_id) : "")}"
                 onerror="this.style.display='none'">
            <div class="cardBody">
              <div class="cardTitle">${esc(p.title || p.playlist_id)}</div>
              <div class="cardMeta">
                <span>${esc(p.channel_title || p.channel_id)}</span>
                ${p.item_count!=null ? `<span>${p.item_count} סרטונים</span>` : ``}
              </div>
            </div>
          </a>
        `).join("")}
      </div>
    ` : `<div class="muted">אין פלייליסטים עדיין.</div>`}
  `);
}

/* ---------- SEARCH ---------- */
async function pageSearch(q){
  if(!q){
    setPage(`<div class="h1">חיפוש</div><p class="sub">הקלד מילה בחיפוש למעלה.</p>`);
    return;
  }
  const si = $("searchInput");
  if (si) si.value = q;

  setPage(`<div class="muted">מחפש…</div>`);
  const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
  const results = data.results || [];

  setPage(`
    <div class="h1">תוצאות חיפוש</div>
    <p class="sub">מילת חיפוש: <b>${esc(q)}</b></p>
    <div class="hr"></div>

    ${results.length ? `
      <div class="grid">
        ${results.map(r=>renderVideoCard(r)).join("")}
      </div>
    ` : `<div class="muted">אין תוצאות.</div>`}
  `);
}

/* ---------- CHANNEL: Load more videos ---------- */
let channelVideosState = { key: "", cursor: null, loading: false, done: false, token: 0 };

async function pageChannel(channel_id, tab){
  const activeTab = (tab === "playlists") ? "playlists" : "videos";

  setPage(`<div class="muted">טוען ערוץ…</div>`);

  // עבור טאב סרטונים — לא צריך להביא פלייליסטים (חוסך שאילתות)
  const include_playlists = activeTab === "playlists" ? "1" : "0";
  const data = await api(`/api/channel?channel_id=${encodeURIComponent(channel_id)}&include_playlists=${include_playlists}&videos_limit=24`);

  const ch = data.channel;
  const playlists = data.playlists || [];

  const header = `
    <div class="avatarRow">
      ${ch.thumbnail_url ? `<img class="avatar" style="width:64px;height:64px" loading="lazy" decoding="async" src="${esc(ch.thumbnail_url)}" onerror="this.style.display='none'">`
                         : `<div class="avatar" style="width:64px;height:64px"></div>`}
      <div style="min-width:0">
        <div class="h1" style="margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(ch.title || ch.channel_id)}</div>
        <p class="sub" style="margin-top:4px">${esc(ch.channel_id)}</p>
      </div>
    </div>

    <div class="btnRow">
      <a class="btn" target="_blank" rel="noreferrer" href="https://www.youtube.com/channel/${encodeURIComponent(ch.channel_id)}">פתח ביוטיוב</a>
    </div>

    <div class="tabs">
      <a class="tab ${activeTab==="videos"?"active":""}" href="/${encodeURIComponent(channel_id)}/videos" data-link>סרטונים</a>
      <a class="tab ${activeTab==="playlists"?"active":""}" href="/${encodeURIComponent(channel_id)}/playlists" data-link>פלייליסטים</a>
    </div>
  `;

  if (activeTab === "playlists") {
    setPage(`
      ${header}
      <div class="hr"></div>
      ${playlists.length ? `
        <div class="grid">
          ${playlists.map(p=>`
            <a class="card" href="/${encodeURIComponent(p.playlist_id)}" data-link>
              <img class="thumb16x9" loading="lazy" decoding="async"
                   src="${esc(p.thumb_video_id ? ytVideoThumb(p.thumb_video_id) : "")}"
                   onerror="this.style.display='none'">
              <div class="cardBody">
                <div class="cardTitle">${esc(p.title || p.playlist_id)}</div>
                <div class="cardMeta">
                  ${p.item_count!=null ? `<span>${p.item_count} סרטונים</span>` : ``}
                </div>
              </div>
            </a>
          `).join("")}
        </div>
      ` : `<div class="muted">אין פלייליסטים (או עדיין לא נטענו).</div>`}
    `);
    return;
  }

  // VIDEOS tab with Load More
  channelVideosState = {
    key: channel_id,
    cursor: data.videos_next_cursor || null,
    loading: false,
    done: !data.videos_next_cursor,
    token: channelVideosState.token + 1
  };
  const t = channelVideosState.token;

  setPage(`
    ${header}
    <div class="hr"></div>

    <div id="chGrid" class="grid">
      ${(data.videos || []).map(v => renderVideoCard({ ...v, channel_id: ch.channel_id, channel_title: ch.title })).join("")}
    </div>

    <div class="btnRow" style="margin-top:14px">
      <button id="chMoreBtn" class="btn" type="button" ${channelVideosState.done ? 'style="display:none"' : ""}>טען עוד</button>
    </div>

    <div id="chHint" class="muted" style="margin-top:8px"></div>
  `);

  const btn = document.getElementById("chMoreBtn");
  btn.onclick = () => channelLoadMoreVideos(t, ch.channel_id, ch.title);
}

async function channelLoadMoreVideos(token, channel_id, channel_title){
  if (channelVideosState.loading || channelVideosState.done) return;
  if (channelVideosState.key !== channel_id) return;

  channelVideosState.loading = true;

  const btn = document.getElementById("chMoreBtn");
  const hint = document.getElementById("chHint");
  const grid = document.getElementById("chGrid");

  btn.disabled = true;
  hint.textContent = "טוען…";

  const url =
    `/api/channel?channel_id=${encodeURIComponent(channel_id)}` +
    `&include_channel=0&include_playlists=0&include_videos=1` +
    `&videos_limit=24` +
    (channelVideosState.cursor ? `&videos_cursor=${encodeURIComponent(channelVideosState.cursor)}` : "");

  const data = await api(url);

  if (token !== channelVideosState.token) return;

  const vids = data.videos || [];
  if (vids.length) {
    const html = vids.map(v => renderVideoCard({ ...v, channel_id, channel_title })).join("");
    grid.insertAdjacentHTML("beforeend", html);
  }

  channelVideosState.cursor = data.videos_next_cursor || null;
  channelVideosState.done = !channelVideosState.cursor || vids.length === 0;

  btn.disabled = false;
  btn.style.display = channelVideosState.done ? "none" : "inline-flex";
  hint.textContent = channelVideosState.done ? "סוף הרשימה." : "";

  channelVideosState.loading = false;
}

/* ---------- VIDEO PAGE ---------- */
async function pageVideo(video_id){
  setPage(`<div class="muted">טוען סרטון…</div>`);
  const data = await api(`/api/video?video_id=${encodeURIComponent(video_id)}`);
  const v = data.video;
  const rec = data.recommended || [];

  const player = `
    <iframe class="player"
      src="https://www.youtube.com/embed/${encodeURIComponent(v.video_id)}?rel=0"
      title="YouTube video player"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      allowfullscreen></iframe>
  `;

  setPage(`
    <div class="watchLayout">
      <section class="watchMain">
        ${player}
        <div class="h1" style="margin-top:10px">${esc(v.title || v.video_id)}</div>
        <p class="sub">${fmtDate(v.published_at) ? `פורסם: ${esc(fmtDate(v.published_at))}` : ""}</p>

        <div class="hr"></div>

        <div class="avatarRow">
          ${v.thumbnail_url ? `<img class="avatar" loading="lazy" decoding="async" src="${esc(v.thumbnail_url)}" onerror="this.style.display='none'">`
                            : `<div class="avatar"></div>`}
          <div style="min-width:0">
            <div style="font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              <a href="/${encodeURIComponent(v.channel_id)}/videos" data-link>${esc(v.channel_title || v.channel_id)}</a>
            </div>
            <div class="muted" style="font-size:12px">${esc(v.channel_id)}</div>
          </div>

          <div style="margin-inline-start:auto" class="btnRow">
            <a class="btn" target="_blank" rel="noreferrer" href="https://www.youtube.com/watch?v=${encodeURIComponent(v.video_id)}">פתח ביוטיוב</a>
          </div>
        </div>
      </section>

      <aside class="watchSide">
        <div style="font-weight:900;margin-bottom:8px">סרטונים מוצעים</div>
        ${rec.length ? rec.map(r=>`
          <a class="reco" href="/${encodeURIComponent(r.video_id)}" data-link>
            <img class="recoThumb" loading="lazy" decoding="async" src="${esc(ytVideoThumb(r.video_id))}">
            <div style="min-width:0">
              <div class="recoTitle">${esc(r.title || r.video_id)}</div>
              <div class="recoMeta">${fmtDate(r.published_at) ? esc(fmtDate(r.published_at)) : ""}</div>
            </div>
          </a>
        `).join("") : `<div class="muted">אין כרגע המלצות מהמסד.</div>`}
      </aside>
    </div>
  `);
}

/* ---------- PLAYLIST PAGE ---------- */
function isChannelId(s){ return /^UC[a-zA-Z0-9_-]{20,}$/.test(s); }
function isPlaylistId(s){ return /^PL[a-zA-Z0-9_-]{10,}$/.test(s); }
function isVideoId(s){ return /^[a-zA-Z0-9_-]{11}$/.test(s); }

async function pagePlaylist(playlist_id){
  setPage(`<div class="muted">טוען פלייליסט…</div>`);
  const data = await api(`/api/playlist?playlist_id=${encodeURIComponent(playlist_id)}`);
  const p = data.playlist;

  const player = `
    <iframe class="player"
      src="https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(p.playlist_id)}&rel=0"
      title="YouTube playlist player"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      allowfullscreen></iframe>
  `;

  setPage(`
    <div class="h1">${esc(p.title || p.playlist_id)}</div>
    <p class="sub">${esc(p.playlist_id)}</p>

    <div class="btnRow">
      <a class="btn" target="_blank" rel="noreferrer" href="https://www.youtube.com/playlist?list=${encodeURIComponent(p.playlist_id)}">פתח ביוטיוב</a>
      <a class="btn" href="/${encodeURIComponent(p.channel_id)}/playlists" data-link>עוד פלייליסטים בערוץ</a>
    </div>

    <div class="hr"></div>

    ${player}
  `);
}

/* ---------- ROUTER ---------- */
async function render(){
  const { parts, qs } = route();

  if(parts.length === 0) return pageHome();
  if(parts[0] === "channels") return pageChannels();
  if(parts[0] === "playlists") return pagePlaylists();
  if(parts[0] === "search") return pageSearch((qs.get("q")||"").trim());

  // /UC.../videos or /UC.../playlists
  if(parts.length >= 1 && isChannelId(parts[0])){
    const tab = parts[1] || "videos";
    return pageChannel(parts[0], tab === "playlists" ? "playlists" : "videos");
  }

  // /PL...
  if(parts.length === 1 && isPlaylistId(parts[0])){
    return pagePlaylist(parts[0]);
  }

  // /VIDEOID
  if(parts.length === 1 && isVideoId(parts[0])){
    return pageVideo(parts[0]);
  }

  setPage(`<div class="h1">לא נמצא</div><p class="sub"><a href="/" data-link>חזרה לבית</a></p>`);
}

/* init */
hookLinks();
headerSearch();
render().catch(showErr);
