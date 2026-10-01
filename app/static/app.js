const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const api = (p, opt={}) => fetch('/api'+p, Object.assign({headers:{'Content-Type':'application/json'}}, opt))
  .then(r=> r.json());
const fmtSize = b => b>1048576 ? (b/1048576).toFixed(1)+' MB' : b>1024 ? (b/1024).toFixed(0)+' KB' : (b||0)+' B';
// 大容量显示（总占用/磁盘剩余用），自动升到 GB / TB
const fmtGB = b => {
  b = b||0;
  if(b>=1099511627776) return (b/1099511627776).toFixed(2)+' TB';
  if(b>=1073741824) return (b/1073741824).toFixed(1)+' GB';
  if(b>=1048576) return (b/1048576).toFixed(0)+' MB';
  return fmtSize(b);
};
const fmtSpeed = b => !b ? '0 KB/s' : b>=1048576 ? (b/1048576).toFixed(2)+' MB/s' : (b/1024).toFixed(0)+' KB/s';
// 秒 → mm:ss / h:mm:ss（视频库进度显示）
const fmtDur = s => {
  s = Math.max(0, Math.round(s||0));
  const h = Math.floor(s/3600), m = Math.floor(s%3600/60), ss = s%60;
  const p = n => String(n).padStart(2,'0');
  return h ? (h+':'+p(m)+':'+p(ss)) : (m+':'+p(ss));
};
const esc = s => (s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// 触发下载时间：今天只显示时分，跨天显示 月-日 时:分
const fmtTime = iso => {
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d.getTime())) return String(iso).slice(0,16).replace('T',' ');
  const p = n => String(n).padStart(2,'0');
  const now = new Date();
  const sameDay = d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth() && d.getDate()===now.getDate();
  return sameDay ? (p(d.getHours())+':'+p(d.getMinutes()))
                 : (p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()));
};

// 每次加载数量选项：100 / 150 / 200 … 1000
const PAGE_SIZES = [];
for(let n=100; n<=1000; n+=50) PAGE_SIZES.push(n);

// 删除任务时是否连带删除源文件（默认开）
const PURGE_KEY = 'twixive.purgeFiles';
let state = {
  source: null, sources: [],
  cats: [], activeGroup: null, activeLeaf: null,
  videos: [], page:1, has_more:false, loading:false, pageSize:100, rawFetched:0,
  tasks: [], taskFilter:'all',
  settings: {}, monitors: [], storage: {},
  purge: localStorage.getItem(PURGE_KEY) !== '0',
  knownUrls: new Set(),   // 已存在/已入队过的视频地址，用于自动跳过重复
  // 视频库（沉浸播放）：筛选条件、已加载条目、收藏/静音状态
  lib: {
    items: [], total: 0, all: 0, page: 1, has_more: false, loading: false,
    cat: '', starOnly: false, q: '', sort: 'time',
    cats: [], starCount: 0, index: 0,
    speed: 1.0, autoNext: true,   // 视频库默认倍速 / 播完自动连播下一条
    seed: '',   // 随机排序用的确定性种子，保证分页加载时顺序不乱
    // 'feed' 沉浸式单条（抖音式） / 'grid' 一行三个的网格
    mute: localStorage.getItem('twixive.libMute') === '1'
  }
};
let booted = false;

function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),2400); }
// 分类 name(/path 或 key) → 中文显示名
function catLabel(n){
  if(!n) return '';
  const c=state.cats.find(x=>x.name===n);
  return c ? (c.label||c.name) : n;
}

// ---- 视图切换 ----
$$('.nav').forEach(n=>n.onclick=()=>{
  $$('.nav').forEach(x=>x.classList.remove('active'));
  n.classList.add('active');
  $$('.view').forEach(v=>v.classList.add('hidden'));
  $('#view-'+n.dataset.view).classList.remove('hidden');
  if(n.dataset.view==='downloads') loadTasks();
  if(n.dataset.view==='library') loadLibrary(true);
  if(n.dataset.view==='recycle') loadRecycle();
  else stopLibrary();   // 离开视频库必须停掉正在播放的视频，否则后台一直在跑
  window.scrollTo({top:0,behavior:'smooth'});
});
$$('[data-goto]').forEach(a=>a.onclick=()=>$('.nav[data-view="'+a.dataset.goto+'"]').click());

// ---- 初始化 ----
async function init(){
  buildPageSize();
  initPurgeToggle();
  try{ state.settings = await api('/settings'); }catch(e){ return; }
  state.pageSize = +state.settings.page_size || 100;
  $('#pageSize').value = String(state.pageSize);
  fillSettings();
  state.source = state.settings.source || 'twixive';
  state.sources = await api('/sources');
  await loadCats();
  await loadMonitors(false);
  await loadStorage(false);
  await loadTasks();
  if(!booted){ setInterval(loadTasks, 2500); booted=true; }
  updateProxyChip();
}
function initPurgeToggle(){
  const cb=$('#purgeFiles'); if(!cb) return;
  cb.checked = state.purge;
  cb.onchange = ()=>{ state.purge = cb.checked; localStorage.setItem(PURGE_KEY, cb.checked?'1':'0'); };
}
function buildPageSize(){
  const sel=$('#pageSize'); sel.innerHTML='';
  PAGE_SIZES.forEach(n=>{
    const o=document.createElement('option');
    o.value=n; o.textContent=n+' 条';
    sel.appendChild(o);
  });
  sel.onchange=async()=>{
    state.pageSize=+sel.value;
    await api('/settings',{method:'POST',body:JSON.stringify({page_size:state.pageSize})});
    state.settings.page_size=state.pageSize;
    toast('每次加载 '+state.pageSize+' 条');
  };
}
function updateProxyChip(){
  const p=state.settings.proxy_url;
  const on=state.settings.proxy_enabled!==false;
  const chip=$('#proxyChip');
  let text;
  if(!on) text = '代理已关闭（走直连）';
  else text = p ? ('代理: '+p) : '代理未开启（未填地址）';
  $('#proxyText').textContent = text;
  chip.classList.toggle('on', on && !!p);
  const dm=$('#proxyDotMobile');
  if(dm){ dm.className='chip-dot'+((on&&p)?' on':''); dm.title = text; }
  // 关闭时把地址输入框置灰，示意当前不生效（地址保留不清空）
  const inp=$('#proxy_url');
  if(inp){ inp.disabled = !on; inp.style.opacity = on?'1':'.5'; }
}
function fillSettings(){
  const s=state.settings;
  $('#proxy_url').value=s.proxy_url||'';
  const pe=$('#proxy_enabled'); if(pe) pe.checked = s.proxy_enabled!==false;
  $('#concurrent').value=s.concurrent??3; $('#rate_delay').value=s.rate_delay??2;
  $('#retry_times').value=s.retry_times??2; $('#max_size_mb').value=s.max_size_mb??0;
  // 视频库：默认倍速 + 自动连播
  state.lib.speed = +s.default_playback_rate || 1;
  state.lib.autoNext = s.auto_play_next !== false;
  const dr=$('#default_playback_rate'); if(dr) dr.value=String(state.lib.speed);
  const ap=$('#auto_play_next'); if(ap) ap.checked=state.lib.autoNext;
  $('#download_path').value=s.download_path||'';
  $('#auto_enabled').checked=!!s.auto_enabled; $('#auto_interval').value=s.auto_interval??60;
  updateProxyChip();
}

// ---- 来源大 tab ----
function renderSourceTabs(){
  const bar=$('#sourceTabs'); bar.innerHTML='';
  state.sources.forEach(x=>{
    const b=document.createElement('button');
    b.className='stab'+(x.key===state.source?' active':'');
    b.textContent=x.name;
    b.onclick=()=>selectSource(x.key);
    bar.appendChild(b);
  });
}
async function selectSource(key){
  if(key===state.source) return;
  state.source=key; state.activeGroup=null; state.activeLeaf=null; state.videos=[]; state.rawFetched=0;
  await api('/settings',{method:'POST',body:JSON.stringify({source:key})});
  state.settings.source=key;
  renderSourceTabs();
  await loadCats();
  await loadMonitors(false);   // 监控列表是跨来源的，切换来源后重新拉一次
  renderTray();
  renderDashboard(state.tasks);
  toast('已切换到 '+key);
}

// ---- 分类（分组 tab + 子按钮）----
async function loadCats(){
  state.cats = await api('/categories');
  renderSourceTabs();
  renderCatTabs();
}
function renderCatTabs(){
  const bar=$('#catTabs'); bar.innerHTML='';
  const groups = [...new Set(state.cats.map(c=>c.group||'其他'))];
  if(!groups.length) return;
  if(!state.activeGroup || !groups.includes(state.activeGroup)) state.activeGroup=groups[0];
  groups.forEach(g=>{
    const b=document.createElement('button');
    b.className='ctab'+(g===state.activeGroup?' active':'');
    const n = state.cats.filter(c=>(c.group||'其他')===g && c.monitored).length;
    b.innerHTML = esc(g) + (n? `<i class="ctab-dot" title="${n} 个分类在监控中"></i>`:'');
    b.onclick=()=>{ state.activeGroup=g; renderCatTabs(); renderCatSubs(); };
    bar.appendChild(b);
  });
  renderCatSubs();
}
function renderCatSubs(){
  const bar=$('#catSubs'); bar.innerHTML='';
  const leaves = state.cats.filter(c=> (c.group||'其他')===state.activeGroup);
  if(!leaves.length) return;
  if(!state.activeLeaf || !leaves.find(c=>c.name===state.activeLeaf)) state.activeLeaf=leaves[0].name;
  leaves.forEach(c=>{
    const b=document.createElement('button');
    b.className='chip'+(c.name===state.activeLeaf?' active':'')+(c.monitored?' mon-on':'');
    b.dataset.name=c.name;
    b.innerHTML=`<span class="cl">${esc(c.label||c.name)}</span>`+
      `<span class="sw" role="switch" aria-checked="${c.monitored?'true':'false'}" `+
      `title="${c.monitored?'取消监控':'开启监控：该分类出现新视频时自动下载'}"><i></i></span>`;
    b.onclick=(e)=>{ if(e.target.closest('.sw')) return; selectLeaf(c.name); };
    b.querySelector('.sw').onclick=(e)=>{ e.stopPropagation(); toggleMonitor(c.name, !c.monitored); };
    bar.appendChild(b);
  });
}
function selectLeaf(name){
  state.activeLeaf=name;
  $$('.chip').forEach(x=>x.classList.toggle('active', x.dataset.name===name));
  state.videos=[]; state.page=1; state.has_more=false; state.rawFetched=0;
  renderTray();
  fetchVideos(name, 1, false);
}
async function toggleMonitor(name, monitored){
  await api('/categories/monitor',{method:'POST',body:JSON.stringify({name,monitored})});
  const c=state.cats.find(x=>x.name===name); if(c) c.monitored=monitored;
  await loadMonitors(false);          // 控制台按「跨来源」全量刷新
  renderCatTabs();
  renderDashboard(state.tasks);
  const label = c ? (c.label||c.name)
    : ((state.monitors.find(m=>m.name===name)||{}).label || name);
  toast(monitored? ('已开启监控：'+label+'，有新视频会自动下载')
                 : ('已关闭监控：'+label));
}
async function fetchVideos(name, page=1, append=false){
  if(state.loading) return;
  state.loading=true;
  setLoadMoreBusy(true);
  toast(append? ('再加载 '+state.pageSize+' 条…') : ('正在拉取「'+name+'」…'));
  // offset = 已拉取的原始条数，站点若钳制单次返回条数也不会错位
  const offset = append ? state.rawFetched : 0;
  const r=await api('/fetch',{method:'POST',body:JSON.stringify({category:name,page,limit:state.pageSize,offset})});
  state.loading=false; setLoadMoreBusy(false);
  if(!r.ok){ toast('拉取失败: '+(r.error||'未知错误')); renderTray(); return; }
  const incoming = r.videos||[];
  let added=0;
  if(!append){ state.videos=incoming.slice(); state.rawFetched=incoming.length; added=incoming.length; }
  else{
    const seen=new Set(state.videos.map(v=>v.url));
    incoming.forEach(v=>{ if(!seen.has(v.url)){ state.videos.push(v); seen.add(v.url); added++; } });
    state.rawFetched += incoming.length;
    // 整页都是重复内容 → 认为没有更多了
    if(added===0) state.has_more=false;
  }
  state.page=r.page||page;
  // 只有确实拿到了新内容才继续开放「加载更多」，避免死循环
  state.has_more = !!r.has_more && added > 0;
  renderTray(); updateLoadMore();
  toast(append? ('新增 '+added+' 条') : ('已加载 '+state.videos.length+' 条'));
}
function setLoadMoreBusy(busy){
  const b=$('#btnLoadMore'); if(!b) return;
  b.classList.toggle('busy', busy);
  b.disabled = busy;
}
function updateLoadMore(){
  const b=$('#btnLoadMore');
  const n=state.videos.length, size=state.pageSize;
  $('#trayCount').textContent = n;
  if(state.has_more && n){
    b.hidden=false;
    b.textContent = `⬇ 加载 ${size} 条（已加载 ${n}）`;
  } else b.hidden=true;
}
function renderTray(){
  const t=$('#videoTray');
  const info=$('#trayInfo');
  if(!state.videos.length){
    t.innerHTML='<p class="empty">'+(state.activeLeaf?'暂无视频，请点「重新拉取」':'请先在上方选择一个分类')+'</p>';
    if(info) info.textContent = state.activeLeaf? '暂无视频' : '请选择分类';
    updateLoadMore(); return;
  }
  t.innerHTML='';
  let dupCount=0;
  state.videos.forEach((v,i)=>{
    const dup = state.knownUrls.has(v.url);
    if(dup) dupCount++;
    const d=document.createElement('div');
    d.className='vcard'+(dup?' dup':' sel'); d.dataset.i=i; d.dataset.url=v.url||'';
    d.innerHTML=`<div class="vimg"><img src="${v.thumbnail||''}" loading="lazy" onerror="this.style.opacity=.2" referrerpolicy="no-referrer"/>
        <button class="play" title="预览">▶</button>
        ${dup?'<span class="vdup" title="已下载过，批量下载会自动跳过">已存在</span>':''}
        <span class="vchk"><input type="checkbox" ${dup?'':'checked'}/></span></div>
      <div class="vt"><div class="t">${esc(v.title)}</div></div>`;
    const cb=d.querySelector('input');
    cb.onchange=e=>d.classList.toggle('sel',e.target.checked);
    d.querySelector('.play').onclick=(e)=>{ e.stopPropagation(); openPreview(v); };
    d.querySelector('.vimg').onclick=(e)=>{ if(e.target.tagName!=='INPUT'&&e.target.className!=='play'){ cb.checked=!cb.checked; d.classList.toggle('sel',cb.checked);} };
    t.appendChild(d);
  });
  if(info) info.textContent = `已加载 ${state.videos.length} 条` + (dupCount? ` · 已存在 ${dupCount} 条（自动跳过）` : '');
  updateLoadMore();
}
$('#videoTray').addEventListener('scroll', ()=>{
  const t=$('#videoTray');
  if(t.scrollTop + t.clientHeight >= t.scrollHeight - 120){
    if(state.has_more && state.activeLeaf && !state.loading) fetchVideos(state.activeLeaf, state.page+1, true);
  }
});
$('#btnFetch').onclick=()=>{
  if(state.activeLeaf){ state.videos=[]; state.page=1; fetchVideos(state.activeLeaf, 1, false); }
  else toast('请先选择一个分类');
};
$('#btnLoadMore').onclick=()=>{ if(state.has_more && state.activeLeaf) fetchVideos(state.activeLeaf, state.page+1, true); };
$('#btnSelAll').onclick=()=>setSel(()=>true);
$('#btnSelNone').onclick=()=>setSel(()=>false);
$('#btnSelInvert').onclick=()=>setSel(v=>!v);
function setSel(fn){
  $$('.vcard').forEach(c=>{
    const cb=c.querySelector('input'); if(!cb) return;
    cb.checked = !!fn(cb.checked);
    c.classList.toggle('sel', cb.checked);
  });
}
$('#btnDownloadSel').onclick=async()=>{
  const items=$$('.vcard.sel').map(c=>({ ...state.videos[+c.dataset.i], category: state.activeLeaf }));
  if(!items.length){ toast('请勾选要下载的视频'); return; }
  const r=await api('/download/selected',{method:'POST',body:JSON.stringify({items})});
  let msg='已加入队列: '+(r.queued||0)+' 个';
  if(r.skipped) msg += ' · 重复跳过 ' + r.skipped + ' 个';
  toast(msg);
  // 把新入队的地址记入已知集合，列表里立即标记为「已存在」
  $$('.vcard.sel').forEach(c=>{ if(c.dataset.url) state.knownUrls.add(c.dataset.url); });
  (r.skipped_urls||[]).forEach(u=>state.knownUrls.add(u));
  renderTray();
  loadTasks();
};

// ---- 任务 / 下载管理 ----
let _proxyTick = 0;
async function loadTasks(){
  state.tasks = await api('/tasks');
  state.knownUrls = new Set(state.tasks.map(t=>t.url).filter(Boolean));
  const tick = _proxyTick++;
  // 代理熔断状态每 2 轮查一次（约 5 秒）
  if((tick % 2)===0){
    try{ state.proxy = await api('/proxy/status'); }catch(e){ /* 忽略 */ }
  }
  // 监控列表每 4 轮（约 10 秒）、磁盘占用每 12 轮（约 30 秒）刷新一次，
  // 后端这两项各自有缓存，不会给服务端造成负担
  if((tick % 4)===0) await loadMonitors(false);
  if((tick % 12)===0) await loadStorage(false);
  renderDashboard(state.tasks);
  renderTaskList(state.tasks);
  updateNavBadges(state.tasks);
  updateHud(state.tasks);
}

// ---- 监控中分类（跨来源全量）----
async function loadMonitors(rerender=true){
  try{ state.monitors = await api('/monitors'); }
  catch(e){ state.monitors = []; }
  if(rerender) renderDashboard(state.tasks);
  return state.monitors;
}

// ---- 下载占用统计 ----
async function loadStorage(rerender=true){
  try{ state.storage = await api('/storage'); }
  catch(e){ state.storage = {}; }
  if(rerender) renderDashboard(state.tasks);
  return state.storage;
}

// ---- 导航栏数量角标 ----
function updateNavBadges(tasks){
  const active = tasks.filter(t=>t.status==='pending'||t.status==='downloading').length;
  const err = tasks.filter(t=>t.status==='error').length;
  const b = document.querySelector('[data-badge="downloads"]');
  if(!b) return;
  const n = active || err;                 // 无进行中则显示待处理的失败数
  b.textContent = n>99 ? '99+' : String(n);
  b.hidden = n===0;
  b.classList.toggle('warn', active===0 && err>0);   // 只剩失败时标红
}

// ---- 实时网速悬浮窗 ----
let _spd = {t:0, bytes:0, ema:0};
function totalSpeed(tasks){
  const dl = tasks.filter(t=>t.status==='downloading');
  if(!dl.length){ _spd.ema=0; _spd.t=0; return 0; }
  // 后端每 0.4s 采样并平滑过的实时速度，优先使用
  const s = dl.reduce((a,t)=>a+(t.speed||0),0);
  if(s>0){ _spd.ema=s; _spd.t=0; return s; }
  // 兜底：按已下字节差分（后端版本较旧、或刚起步还没采样到）
  const bytes = dl.reduce((a,t)=>a+(t.size||0),0);
  const now = Date.now();
  if(!_spd.t){ _spd.t=now; _spd.bytes=bytes; return _spd.ema; }
  const dt = (now-_spd.t)/1000;
  if(dt>=1.5){
    const d = bytes-_spd.bytes;
    if(d>0){ const inst=d/dt; _spd.ema = _spd.ema ? 0.5*_spd.ema+0.5*inst : inst; }
    _spd.t=now; _spd.bytes=bytes;
  }
  return _spd.ema;
}
function updateHud(tasks){
  const dl = tasks.filter(t=>t.status==='downloading');
  const pend = tasks.filter(t=>t.status==='pending').length;
  const err = tasks.filter(t=>t.status==='error').length;
  const sp = totalSpeed(tasks);
  const hud = $('#speedHUD'); if(!hud) return;
  // 代理熔断中：优先展示暂停提示，任务在等待而不是被判失败
  const ps = state.proxy || {};
  if(ps.paused){
    hud.classList.add('err'); hud.classList.remove('idle');
    $('#hudSpeed').textContent = '⏸ 已暂停';
    $('#hudInfo').textContent = `代理不可用，${ps.remaining}s 后自动重试`;
    $('#hudBar').style.width = '0%';
    return;
  }
  hud.classList.remove('err');
  hud.classList.toggle('idle', dl.length===0);
  const direct = ps.enabled===false;
  $('#hudSpeed').textContent = dl.length ? fmtSpeed(sp) : '空闲';
  $('#hudInfo').textContent = dl.length
    ? `下载中 ${dl.length} · 等待 ${pend}` + (err? ` · 失败 ${err}`:'') + (direct? ' · 直连':'')
    : (pend ? `等待中 ${pend} 个任务` : (err? `失败 ${err} 个待重试` : (direct? '当前没有下载任务（直连模式）' : '当前没有下载任务')));
  const avg = dl.length ? dl.reduce((a,t)=>a+(t.progress||0),0)/dl.length : 0;
  $('#hudBar').style.width = Math.max(0,Math.min(100,avg))+'%';
}
$('#speedHUD').onclick = ()=>{ const n=$('.nav[data-view="downloads"]'); if(n) n.click(); };
const STATUS_TABS = [
  {key:'all',label:'全部'},{key:'pending',label:'等待中'},{key:'downloading',label:'下载中'},
  {key:'done',label:'成功'},{key:'error',label:'失败'},{key:'skipped',label:'已跳过'},
  {key:'mon',label:'📡 监控'}
];
const STATUS_ZH = {pending:'等待中',downloading:'下载中',done:'已完成',
  error:'失败',cancelled:'已取消',skipped:'已跳过'};
function matchFilter(t, key){
  if(key==='all') return true;
  if(key==='mon') return !!t.monitored;
  return t.status===key;
}
function renderStatusTabs(){
  const bar=$('#statusTabs'); bar.innerHTML='';
  STATUS_TABS.forEach(s=>{
    const n=state.tasks.filter(t=>matchFilter(t,s.key)).length;
    const b=document.createElement('button');
    b.className='stab'+(s.key===state.taskFilter?' active':'')+(s.key==='error'&&n?' danger':'');
    b.innerHTML=`${s.label} <span class="cnt">${n}</span>`;
    b.onclick=()=>{ state.taskFilter=s.key; renderStatusTabs(); renderTaskList(state.tasks); };
    bar.appendChild(b);
  });
}
function renderTaskList(tasks){
  renderStatusTabs();
  const el=$('#taskList');
  let list = tasks.filter(t=>matchFilter(t,state.taskFilter));
  if(!list.length){ el.innerHTML='<p class="empty">该筛选下还没有任务</p>'; return; }
  el.innerHTML=list.map(t=>taskRow(t)).join('');
  bindTaskActs(el);
}
// 已完成的任务不该显示报错（历史数据里可能残留重试过程中的中间状态文案）
const showErr = t => !!(t.error && t.status!=='done');

function taskRow(t){
  const ic={pending:'⏳',downloading:'⬇',done:'✅',error:'⚠️',cancelled:'⛔',skipped:'⏭'}[t.status]||'•';
  const cls={done:'done',error:'err'}[t.status]||'';
  const pct=Math.max(0,Math.min(100,t.progress||0));
  const thumb = t.thumbnail
    ? `<img class="tthumb" src="${t.thumbnail}" loading="lazy" onerror="this.style.display='none'" referrerpolicy="no-referrer"/>`
    : `<div class="tthumb ph">🎬</div>`;
  const retry = (t.status==='error'||t.status==='cancelled') ? '<button data-act="retry">重试</button>' : '';
  const cancel = (t.status==='pending'||t.status==='downloading') ? '<button data-act="cancel">取消</button>' : '';
  const mon = t.monitored ? '<span class="badge mon-b" title="来自监控中的分类">📡 监控</span>' : '';
  const tm = '<span class="mc ttime" title="触发下载时间">🕒 '+fmtTime(t.created_at)+'</span>';
  const delTitle = (state.purge && t.path) ? '删除任务，并删除源文件（移入回收站，可恢复）' : '只删除任务记录';
  const delTxt = (state.purge && t.path) ? '删除+文件' : '删除';
  return `<div class="task ${cls}" data-id="${t.id}">
    <div class="ic">${ic}</div>
    ${thumb}
    <div class="body">
      <div class="tt">${esc(t.title)}</div>
      <div class="bar ${cls}"><i style="width:${pct}%"></i></div>
      <div class="meta"><span class="badge ${t.status}">${STATUS_ZH[t.status]||t.status}</span> ${mon} <span class="mc">${esc(catLabel(t.category))} · ${fmtSize(t.size)}</span> ${tm} ${showErr(t)?('<span class="me">'+esc(t.error)+'</span>'):''}</div>
    </div>
    <div class="acts">
      <button data-act="preview" title="预览">▶</button>
      ${retry}${cancel}
      <button data-act="del" title="${delTitle}">${delTxt}</button>
    </div></div>`;
}
function bindTaskActs(scope){
  $$('.task',scope).forEach(row=>{
    const id=row.dataset.id;
    row.querySelectorAll('[data-act]').forEach(b=>b.onclick=async()=>{
      const act=b.dataset.act;
      if(act==='cancel'){ await api('/tasks/'+id+'/cancel',{method:'POST'}); loadTasks(); return; }
      if(act==='retry'){ await api('/tasks/'+id+'/retry',{method:'POST'}); loadTasks(); return; }
      if(act==='preview'){ const t=state.tasks.find(x=>x.id===id); if(t) openPreview(t); return; }
      if(act==='del'){
        const t=state.tasks.find(x=>x.id===id)||{};
        const hasFile=!!t.path;
        if(state.purge && hasFile){
          // 源文件删了就找不回来，动手前必须确认一次
          if(!confirm('删除任务「'+(t.title||'')+'」\n并将源文件移入回收站（'+(t.size?fmtSize(t.size):'文件')+'）？\n\n文件会先进回收站，可在「回收站」恢复或彻底删除。若只想删记录，先取消勾选「删除时同时删源文件」。')) return;
        }
        const r=await api('/tasks/'+id+(state.purge?'?purge=1':''),{method:'DELETE'});
        toast(state.purge&&r.freed? ('已删除任务，释放 '+fmtGB(r.freed)) : '已删除任务记录');
        loadStorage(false);
        loadTasks();
        return;
      }
      loadTasks();
    });
  });
}
$('#btnClear').onclick=async()=>{
  const done=state.tasks.filter(t=>['done','error','cancelled','skipped'].includes(t.status));
  if(!done.length){ toast('没有可清除的任务'); return; }
  let purge=state.purge;
  if(purge){
    const sz=done.reduce((a,t)=>a+(t.size||0),0);
    if(!confirm('清除 '+done.length+' 条已结束任务，并将源文件移入回收站（约 '+fmtGB(sz)+'）？\n\n文件会先进回收站，可在「回收站」彻底删除腾出空间。')) return;
  }
  const r=await api('/tasks/clear'+(purge?'?purge=1':''),{method:'POST'});
  toast('已清除 '+done.length+' 条'+(r.freed?('，释放 '+fmtGB(r.freed)):''));
  loadStorage(false);
  loadTasks();
};

// ---- 回收站（软删除：删除的源文件先移入回收站，可恢复 / 可彻底删）----
async function loadRecycle(){
  const list=$('#recList'), sum=$('#recSummary'), empty=$('#recEmpty');
  if(!list) return;
  let data;
  try{ data=await api('/recycle'); }catch(e){ toast('回收站加载失败：'+e); return; }
  const items=data.items||[];
  const badge=document.querySelector('[data-badge="recycle"]');
  if(badge){ badge.textContent=items.length; badge.hidden=!items.length; }
  if(!items.length){ list.innerHTML=''; if(sum) sum.textContent=''; if(empty) empty.hidden=false; return; }
  if(empty) empty.hidden=true;
  if(sum) sum.textContent=`共 ${items.length} 项 · 占用 ${fmtGB(data.total_size||0)} · 超过保留期(默认30天)将自动清理`;
  list.innerHTML=items.map(it=>{
    const name=esc(it.title||'(未命名)');
    const sz=fmtSize(it.size||0);
    const dt=fmtTime(it.deleted_at);
    const loc=esc(it.original_dir||'');
    return `<div class="task rec-item" data-id="${it.id}">
      <div class="ic"><span class="mc">🗑</span></div>
      <div class="body">
        <div class="tt">${name}</div>
        <div class="meta"><span class="badge">${sz}</span> · <span class="mc" title="删除时间">🕒 ${dt}</span> <span class="mc" title="原位置">📁 ${loc}</span></div>
      </div>
      <div class="acts">
        <button data-act="restore" title="恢复到原位置">恢复</button>
        <button data-act="del" title="彻底删除（不可恢复）">彻底删除</button>
      </div></div>`;
  }).join('');
  bindRecycleActs(list);
}
function bindRecycleActs(scope){
  scope.querySelectorAll('.rec-item').forEach(row=>{
    const id=row.dataset.id;
    row.querySelectorAll('[data-act]').forEach(b=>b.onclick=async()=>{
      const act=b.dataset.act;
      if(act==='restore'){
        const r=await api('/recycle/restore',{method:'POST',body:JSON.stringify({id})});
        if(r.ok){ toast('已恢复到原位置'); loadRecycle(); loadStorage(false); }
        else toast('恢复失败：'+(r.error||'未知'));
      } else if(act==='del'){
        if(!confirm('彻底删除该文件？此操作不可恢复。')) return;
        const r=await api('/recycle/'+id,{method:'DELETE'});
        if(r.ok){ toast('已彻底删除'); loadRecycle(); loadStorage(false); }
        else toast('删除失败：'+(r.error||'未知'));
      }
    });
  });
}
$('#btnEmptyRecycle').onclick=async()=>{
  const data=await api('/recycle').catch(()=>({count:0}));
  if(!(data.count)){ toast('回收站已是空的'); return; }
  if(!confirm(`清空回收站（${data.count} 项）？这些文件将被彻底删除，不可恢复。`)) return;
  const r=await api('/recycle/empty',{method:'POST'});
  toast('已清空回收站（'+(r.removed||0)+' 项）');
  loadRecycle(); loadStorage(false);
};
$('#btnRetryFailed').onclick = retryFailed;
$('#btnRetryFailed2').onclick = retryFailed;
async function retryFailed(){
  const r=await api('/tasks/retry_failed',{method:'POST'});
  toast('已重新入队: '+r.retried+' 个'); loadTasks();
}
$('#btnAutoRun').onclick=async()=>{ const r=await api('/auto/run',{method:'POST'}); toast('自动抓取新增: '+r.added+' 个'); loadTasks(); };

// ---- 控制台（动态总览）----
function renderDashboard(tasks){
  const c={pending:0,downloading:0,done:0,error:0,skipped:0};
  tasks.forEach(t=>{ if(c[t.status]!=null)c[t.status]++; });
  const mon = state.monitors.length;
  // 下载总量（后端扫盘统计真实文件大小，30s 缓存）
  const sto = state.storage || {};
  const disk = sto.disk || {};
  const storeTxt = (sto.bytes!=null) ? fmtGB(sto.bytes) : '—';
  let storeSub = '读取中…';
  if(sto.bytes!=null){
    storeSub = `${sto.files||0} 个文件`;
    // 扫盘实际大小与「库里已完成任务之和」有出入时，把记录值一并显示，便于对照
    const trk = sto.tracked||0;
    if(trk>0 && Math.abs(sto.bytes-trk) > Math.max(trk*0.02, 104857600))
      storeSub += ` · 记录 ${fmtGB(trk)}`;
  }
  const storeTitle = (()=>{
    if(sto.bytes==null) return '正在统计下载目录…';
    let s = `下载目录 ${sto.path||''}：实际 ${fmtGB(sto.bytes)}（${sto.files||0} 个文件）`;
    if(sto.tracked) s += `；面板记录 ${fmtGB(sto.tracked)}，差额多为未入库的历史文件`;
    if(disk.total!=null) s += `；磁盘共 ${fmtGB(disk.total)}，剩余 ${fmtGB(disk.free)}`;
    return s;
  })();
  $('#stats').innerHTML=`
    <div class="stat s1"><div class="ic">⏳</div><div class="n">${c.pending}</div><div class="l">等待中</div></div>
    <div class="stat s2"><div class="ic">⬇</div><div class="n">${c.downloading}</div><div class="l">下载中</div></div>
    <div class="stat s3"><div class="ic">✅</div><div class="n">${c.done}</div><div class="l">已完成</div></div>
    <div class="stat s4"><div class="ic">⚠️</div><div class="n">${c.error}</div><div class="l">失败</div></div>
    <div class="stat s5"><div class="ic">📡</div><div class="n">${mon}</div><div class="l">监控中分类</div></div>
    <div class="stat s6" title="${esc(storeTitle)}">
      <div class="ic">💾</div><div class="n">${storeTxt}</div><div class="l">下载总量 · ${storeSub}</div></div>`;
  // 实时动态
  const feed=tasks.slice(0,12);
  $('#feedCount').textContent = feed.length+' 条';
  $('#liveFeed').innerHTML = feed.length? feed.map(t=>{
    const dot={pending:'dot w',downloading:'dot b',done:'dot g',error:'dot r',cancelled:'dot m',skipped:'dot s'}[t.status]||'dot';
    return `<div class="feed-row"><span class="${dot}"></span>
      <span class="ft">${esc(t.title)}</span>
      ${t.monitored?'<span class="badge mon-b">📡</span>':''}
      <span class="badge ${t.status}">${STATUS_ZH[t.status]||t.status}</span>
      <span class="fm">${esc(catLabel(t.category))}</span>
      <span class="ftime" title="触发时间">🕒 ${fmtTime(t.created_at)}</span></div>`;
  }).join('') : '<p class="empty">暂无动态</p>';
  // 监控中分类（跨来源全量；这里也能直接关掉）
  const monList = state.monitors || [];
  const monTag = $('#monCount'); if(monTag) monTag.textContent = monList.length ? monList.length+' 个' : '';
  $('#monList').innerHTML = monList.length? monList.map(c=>`
    <div class="mon-row">
      <span class="radar" aria-hidden="true"></span>
      <span class="mr-name">${esc(c.label||c.name)}</span>
      ${c.source?`<span class="src" title="所属来源">${esc(c.source==='twivideo'?'TwiVideo':'TwiXive')}</span>`:''}
      ${c.known===false?'<span class="src warn" title="该分类已不在来源的当前分类列表里（旧版命名），仍会继续监控">旧</span>':''}
      <span class="sw on" role="switch" aria-checked="true" data-mon="${esc(c.name)}"
            title="点击取消监控"><i></i></span>
    </div>`).join('') : '<p class="empty">暂无监控，去「分类下载」打开分类右侧的开关</p>';
  $$('#monList .sw').forEach(sw=>{
    sw.onclick=()=>toggleMonitor(sw.dataset.mon, false);
  });
  // 正在下载
  const dl = tasks.filter(t=>t.status==='downloading');
  $('#dlNow').innerHTML = dl.length? dl.map(t=>{
    const pct=Math.max(0,Math.min(100,t.progress||0));
    return `<div class="mini"><div class="mt">${esc(t.title)}</div><div class="mbar"><i style="width:${pct}%"></i></div></div>`;
  }).join('') : '<p class="empty">当前没有下载任务</p>';
  // 失败待重试
  const errs = tasks.filter(t=>t.status==='error').slice(0,6);
  $('#errList').innerHTML = errs.length? errs.map(t=>`<div class="mini warn"><div class="mt">${esc(t.title)}</div><div class="me">${esc(t.error||'')}</div></div>`).join('') : '<p class="empty">没有失败任务 🎉</p>';
}

// ==================== 视频库（沉浸播放） ====================
// 数据来自扫盘：磁盘上真实存在的视频文件。上下滑动切换、进入视口自动播放，
// 收藏与播放进度按「文件相对路径」存库，任务记录被清掉也不会丢。
const LIB_PAGE = 40;
const LIB_SORTS = [['time','时间 ↓'],['size','大小 ↓'],['name','名称 ↑'],['random','随机']];
const LIB_SPEED = 3;        // 长按倍速（抖音同款 3×）
const LIB_SEEK_RATIO = 0.6; // 画面上横向划过整屏 ≈ 快进总时长的 60%
const LIB_PROG_RATIO = 1;   // 进度条上横向拖过整条 ≈ 走完整段视频（相对位移，不跟手指绝对位置）
const LIB_PRELOAD_AHEAD = 3; // 预加载：当前 + 前 1 + 后 3 条，滑到下一条即时播放不卡
let libObs = null;
let libMouse = null;        // 桌面端「按住倍速 / 横向拖动快进」的当前会话

// 统一线性图标（stroke 风格，颜色跟随 currentColor；实心状态由 CSS 控制 fill）
const svgIc = (d, opt='') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" `
  + `stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${opt}>${d}</svg>`;
const ICON = {
  heart:  svgIc('<path d="M12 20.6C6.9 17.2 3.4 13.9 3.4 9.8A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8.6 2.8c0 4.1-3.5 7.4-8.6 10.8Z"/>'),
  share:  svgIc('<path d="M4 13v5.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V13"/><path d="M12 3.5V15"/><path d="M7.5 8 12 3.5 16.5 8"/>'),
  sound:  svgIc('<path d="M11 5 6.5 9H3.5v6h3L11 19V5Z"/><path d="M15.2 9.2a4 4 0 0 1 0 5.6"/><path d="M17.9 6.6a7.6 7.6 0 0 1 0 10.8"/>'),
  mute:   svgIc('<path d="M11 5 6.5 9H3.5v6h3L11 19V5Z"/><path d="m15.5 9.5 5 5"/><path d="m20.5 9.5-5 5"/>'),
  open:   svgIc('<path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M18 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5"/>'),
  trash:  svgIc('<path d="M4 7h16"/><path d="M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7"/><path d="M6.5 7l.9 12.1A2 2 0 0 0 9.4 21h5.2a2 2 0 0 0 2-1.9L17.5 7"/><path d="M10.5 11v6M13.5 11v6"/>'),
  sort:   svgIc('<path d="M7 20V4"/><path d="M3.5 16.5 7 20l3.5-3.5"/><path d="M17 4v16"/><path d="M13.5 7.5 17 4l3.5 3.5"/>'),
  play:   svgIc('<path d="M7 4.8v14.4L19 12 7 4.8Z" fill="currentColor" stroke-width="1.2"/>'),
  seekL:  svgIc('<path d="M11 6 4.5 12 11 18"/><path d="M20 6l-6.5 6L20 18"/>', 'stroke-width="2.1"'),
  seekR:  svgIc('<path d="M13 6l6.5 6L13 18"/><path d="M4 6l6.5 6L4 18"/>', 'stroke-width="2.1"'),
};

// 桌面端手势：按住不动 = 倍速，横向拖动 = 快进（纵向留给滚动切换）
window.addEventListener('mousemove', e=>{
  const m = libMouse; if(!m) return;
  const dx = e.clientX - m.sx, dy = e.clientY - m.sy;
  if(!m.moved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)){
    m.moved = true; clearTimeout(m.lpTimer);
    if(m.speeding){ m.speeding = false; m.v.playbackRate = state.lib.speed; m.el.classList.remove('speeding'); }
  }
  if(m.moved && !m.axis) m.axis = Math.abs(dx) > Math.abs(dy) * 1.3 ? 'x' : 'y';
  if(m.axis !== 'x') return;
  const v = m.v, el = m.el, w = el.clientWidth || 1;
  if(!m.seeking && Math.abs(dx) > 12){
    m.seeking = true; m.seekX0 = m.sx; m.seekFrom = v.currentTime || 0;
    el.classList.add('seeking'); paintLibSeek(el, v, 0);
  }
  if(m.seeking && v.duration){
    const nt = Math.max(0, Math.min(v.duration,
      m.seekFrom + (e.clientX - m.seekX0) / w * v.duration * LIB_SEEK_RATIO));
    try{ v.currentTime = nt; }catch(_){}
  }
});
window.addEventListener('mouseup', ()=>{
  const m = libMouse; if(!m) return;
  libMouse = null; clearTimeout(m.lpTimer);
  if(m.speeding){ m.v.playbackRate = state.lib.speed; m.el.classList.remove('speeding'); }
  if(m.seeking){ m.el.classList.remove('seeking'); hideLibTip(); saveLibProgress(m.el); }
});

const libItems = () => $$('.lib-item');

async function loadLibrary(reset){
  const L = state.lib;
  if(L.loading) return;
  L.loading = true;
  if(reset) L.page = 1;
  const qs = new URLSearchParams({ cat:L.cat, star:L.starOnly?'1':'0',
    q:L.q, page:String(L.page), limit:String(LIB_PAGE), sort:L.sort });
  if(L.sort === 'random' && L.seed) qs.set('seed', L.seed);
  const tip = $('#libLoading');
  if(tip){ tip.hidden = false; tip.textContent = reset ? '加载中…' : '加载更多…'; }
  try{
    const r = await api('/library?'+qs.toString());
    L.total = r.total||0; L.all = r.all||0; L.has_more = !!r.has_more;
    L.cats = r.cats||[]; L.starCount = r.star_count||0;
    const incoming = r.items||[];
    if(reset){
      L.items = incoming;
      renderLibFeed();
    } else {
      const feed = $('#libFeed');
      incoming.forEach(it=>{
        L.items.push(it);
        feed.appendChild(makeLibItem(it, L.items.length-1));
      });
      applyLibMuteUI();
      setupLibObserver();
    }
    renderLibCats();
    updateLibEmpty();
  }catch(e){ toast('视频库加载失败：'+e); }
  finally{ L.loading = false; if(tip) tip.hidden = true; }
}

function renderLibFeed(){
  const feed = $('#libFeed');
  feed.innerHTML = '';
  state.lib.items.forEach((it,i)=> feed.appendChild(makeLibItem(it,i)));
  applyLibMuteUI();
  setupLibObserver();
  state.lib.index = 0;
}

function makeLibItem(it, i){
  const el = document.createElement('div');
  el.className = 'lib-item paused' + (it.star ? ' starred' : '');
  el.dataset.i = i;
  el.dataset.path = it.path;
  el.innerHTML = libItemHTML(it);
  const v = el.querySelector('video');
  if(it.thumb) v.poster = it.thumb;
  bindLibItem(el, v);
  return el;
}

function libItemHTML(it){
  const resume = it.position > 5
    ? `<span title="上次播放到 ${fmtDur(it.position)}">⏱ 续播 ${fmtDur(it.position)}</span>` : '';
  const avatar = ((it.cat_label||'库').trim()[0] || '库');
  const dur = it.duration ? fmtDur(it.duration) : '';
  return `<video src="/api/media/stream?path=${encodeURIComponent(it.path)}"
      preload="none" playsinline webkit-playsinline></video>
    <div class="lib-burst">${ICON.heart}</div>
    <div class="lib-seek">
      <span class="lsk-arrow lsk-back">${ICON.seekL}</span>
      <span class="lsk-t"><b>00:00</b> / 00:00</span>
      <span class="lsk-arrow lsk-fwd">${ICON.seekR}</span>
    </div>
    <div class="lib-speed"><b>${LIB_SPEED}×</b> 倍速播放中</div>
    <div class="lib-side">
      <div class="ls-avatar" title="${esc(it.cat_label||'未分类')}">${esc(avatar)}</div>
      <button class="lsb star${it.star?' on':''}" data-act="star" title="收藏（双击画面也可）"><span class="ls-ic">${ICON.heart}</span><span class="ls-n">收藏</span></button>
      <button class="lsb" data-act="share" title="复制视频地址"><span class="ls-ic">${ICON.share}</span><span class="ls-n">分享</span></button>
      <button class="lsb" data-act="mute" title="静音 / 取消静音">
        <span class="ls-ic"><span class="ic-sound">${ICON.sound}</span><span class="ic-mute">${ICON.mute}</span></span>
        <span class="ls-n">静音</span>
      </button>
      <button class="lsb" data-act="open" title="新窗口打开"><span class="ls-ic">${ICON.open}</span><span class="ls-n">打开</span></button>
      <button class="lsb del" data-act="del" title="删除文件"><span class="ls-ic">${ICON.trash}</span><span class="ls-n">删除</span></button>
    </div>
    <div class="lib-meta">
      <div class="lm-title">${esc(it.title)}${it.url?` <a class="lm-src" href="${esc(it.url)}" target="_blank" rel="noopener" title="打开来源页面">来源 ↗</a>`:''}</div>
      <div class="lm-sub">
        <b>${esc(it.cat_label||'未分类')}</b>
        <span>${fmtGB(it.size)}</span>
        ${dur?`<span>⏱ ${dur}</span>`:''}
        <span>🕒 ${fmtTime(it.mtime)}</span>
        ${it.plays?`<span>看过 ${it.plays} 次</span>`:''}
        ${resume}
      </div>
    </div>
    <div class="lib-prog">
      <div class="lp-tip"><b>00:00</b> / 00:00</div>
      <div class="lp-track"><i></i><b class="lp-knob"></b></div>
    </div>`;
}

function bindLibItem(el, v){
  let lastSave = 0;
  let clickTimer = null;
  const itemOf = () => state.lib.items[+el.dataset.i];
  // ---- 底部进度条：抖音式——按下只是「抓住」，进度按手指左右位移增减，不会一按就跳 ----
  const prog = el.querySelector('.lib-prog');
  let progDrag = false, progX0 = 0, progFrom = 0, progMoved = false;
  let progWasPlaying = false, progRaf = 0, progTarget = 0, progTipT = null;
  const applyProg = ()=>{          // rAF 节流：一次拖动只触发必要次数的 seek
    progRaf = 0;
    try{ v.currentTime = progTarget; }catch(e){}
    paintLibProg(el, v);
  };
  const progDown = e=>{
    progDrag = true; progMoved = false;
    progX0 = e.clientX; progFrom = v.currentTime || 0; progTarget = progFrom;
    clearTimeout(progTipT);
    if(e.pointerId != null && prog.setPointerCapture){ try{ prog.setPointerCapture(e.pointerId); }catch(_){} }
  };
  const progMove = e=>{
    if(!progDrag || !v.duration) return;
    const dx = e.clientX - progX0;
    if(!progMoved && Math.abs(dx) < 5) return;   // 轻微抖动不算拖动
    if(!progMoved){
      progMoved = true;
      progWasPlaying = !v.paused;
      if(progWasPlaying) v.pause();        // 真正开始拖动才定格，跟抖音一致
      prog.classList.add('drag');
    }
    e.preventDefault();
    const w = prog.getBoundingClientRect().width || 1;
    const delta = dx / w * v.duration * LIB_PROG_RATIO;
    progTarget = Math.max(0, Math.min(v.duration, progFrom + delta));
    if(!progRaf) progRaf = requestAnimationFrame(applyProg);
  };
  const progUp = ()=>{
    if(!progDrag) return;
    progDrag = false;
    if(progRaf){ cancelAnimationFrame(progRaf); progRaf = 0; }
    if(progMoved){
      try{ v.currentTime = progTarget; }catch(e){}
      paintLibProg(el, v);
      saveLibProgress(el);
      prog.classList.remove('drag');
      if(progWasPlaying) v.play().catch(()=> el.classList.add('paused'));
    } else {
      // 点了一下进度条 = 进入全屏（下部分点一下就全屏）
      prog.classList.remove('drag');
      toggleLibFullscreen(el);
    }
  };
  prog.addEventListener('pointerdown', e=>{
    if(progDrag) return;
    if(e.target.closest('.lsb')) return;
    progDown(e);
  });
  prog.addEventListener('pointermove', progMove);
  prog.addEventListener('pointerup', progUp);
  prog.addEventListener('pointercancel', progUp);

  // ---- 长按倍速 + 左右滑动快进 ----
  let sx=0, sy=0, axis=null, moved=false, seeking=false, seekFrom=0, seekX0=0, lpTimer=null, speeding=false;
  const startSpeed = ()=>{
    if(speeding || !v.duration) return;
    speeding = true; v.playbackRate = LIB_SPEED;
    el.classList.add('speeding');
    if(v.paused) v.play().catch(()=>{});
  };
  const stopSpeed = ()=>{
    if(!speeding) return;
    speeding = false; v.playbackRate = state.lib.speed; el.classList.remove('speeding');
  };
  const beginSeek = x=>{
    seeking = true; seekX0 = x; seekFrom = v.currentTime || 0;
    el.classList.add('seeking'); paintLibSeek(el, v, 0);
  };
  const endSeek = ()=>{
    if(!seeking) return;
    seeking = false; el.classList.remove('seeking'); hideLibTip(); saveLibProgress(el);
  };
  el.addEventListener('touchstart', e=>{
    if(e.touches.length !== 1){ stopSpeed(); return; }
    if(e.target.closest('.lib-prog') || e.target.closest('.lsb') || e.target.closest('a')) return;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; axis = null; moved = false;
    clearTimeout(lpTimer);
    lpTimer = setTimeout(()=>{ if(!moved) startSpeed(); }, 300);
  }, {passive:true});
  el.addEventListener('touchmove', e=>{
    if(e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if(!moved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)){
      moved = true; clearTimeout(lpTimer); stopSpeed();
    }
    if(!axis && (Math.abs(dx) > 12 || Math.abs(dy) > 12)){
      axis = Math.abs(dx) > Math.abs(dy) * 1.3 ? 'x' : 'y';
    }
    if(axis === 'x'){
      if(e.cancelable) e.preventDefault();      // 拦住横向手势，纵向滚动照常
      if(!seeking) beginSeek(t.clientX);
      const w = el.clientWidth || 1;
      let delta = (t.clientX - seekX0) / w * (v.duration || 0) * LIB_SEEK_RATIO;
      const nt = Math.max(0, Math.min(v.duration || 0, seekFrom + delta));
      try{ v.currentTime = nt; }catch(_){}
    }
  }, {passive:false});
  el.addEventListener('touchend', ()=>{
    clearTimeout(lpTimer); stopSpeed(); endSeek();
  }, {passive:true});
  el.addEventListener('touchcancel', ()=>{
    clearTimeout(lpTimer); stopSpeed(); endSeek();
  }, {passive:true});

  // 桌面端：按住画面 = 倍速，按住横向拖动 = 快进（走全局控制器，避免每条重复挂监听）
  el.addEventListener('mousedown', e=>{
    if(e.button !== 0) return;
    if(e.target.closest('.lib-prog') || e.target.closest('.lsb') || e.target.closest('a')) return;
    libMouse = {el, v, sx:e.clientX, sy:e.clientY, axis:null, moved:false,
                speeding:false, seeking:false, seekFrom:0, seekX0:0, lpTimer:null};
    libMouse.lpTimer = setTimeout(()=>{
      if(libMouse && !libMouse.moved && v.duration){
        libMouse.speeding = true; v.playbackRate = LIB_SPEED;
        el.classList.add('speeding');
        if(v.paused) v.play().catch(()=>{});
      }
    }, 300);
  });

  v.addEventListener('loadedmetadata', ()=>{
    const it = itemOf(); if(!it) return;
    if(v.duration && Math.abs((it.duration||0) - v.duration) > 2){
      it.duration = v.duration;
      api('/media/meta',{method:'POST',body:JSON.stringify({path:it.path, duration:v.duration})});
    }
    // 续播：上次看到 5 秒以上、且离结尾还有 10 秒以上
    if(it.position > 5 && v.duration && it.position < v.duration - 10){
      try{ v.currentTime = it.position; }catch(e){}
    }
  });
  v.addEventListener('timeupdate', ()=>{
    paintLibProg(el, v);
    if(el.classList.contains('seeking')) paintLibSeek(el, v, v.currentTime - seekFrom);
    const now = Date.now();
    if(now - lastSave > 5000){ lastSave = now; saveLibProgress(el); }
  });
  v.addEventListener('play', ()=>{
    if(el.dataset.priming && state.lib.index !== +el.dataset.i) return; // 仅预热播放，不计次
    el.dataset.priming = '';
    el.classList.remove('paused');
    const it = itemOf();
    if(it && !el.dataset.counted){
      el.dataset.counted = '1';
      it.plays = (it.plays||0) + 1;
      api('/media/meta',{method:'POST',body:JSON.stringify({path:it.path, play:true})});
    }
  });
  v.addEventListener('pause', ()=>{ el.classList.add('paused'); saveLibProgress(el); });

  // 单击：下部分（底部 28%）点一下 = 全屏；其余区域 = 播放/暂停；240ms 内第二次点击 = 收藏
  el.addEventListener('click', e=>{
    if(e.target.closest('.lsb') || e.target.closest('a') || e.target.closest('.lp-track')) return;
    const r = el.getBoundingClientRect();
    const inBottom = ((e.clientY - r.top) / (r.height || 1)) > 0.72;
    if(clickTimer){ clearTimeout(clickTimer); clickTimer = null; libStar(el, true); return; }
    clickTimer = setTimeout(()=>{
      clickTimer = null;
      if(inBottom) toggleLibFullscreen(el);
      else { if(v.paused) v.play().catch(()=>{}); else v.pause(); }
    }, 240);
  });
  el.querySelectorAll('.lsb').forEach(b=> b.addEventListener('click', e=>{
    e.stopPropagation();
    const act = b.dataset.act;
    if(act==='star') libStar(el);
    else if(act==='mute') libToggleMute();
    else if(act==='share') libCopyLink(el);
    else if(act==='open') libOpen(el);
    else if(act==='del') libDelete(el);
  }));
  // 自动连播：去掉原生 loop，由 ended 事件接管（受设置开关控制）
  v.loop = !state.lib.autoNext;
  v.addEventListener('ended', ()=>{ if(state.lib.autoNext) autoPlayNext(el); });
}

// 播完自动连播下一条：滚到下一条，由 IntersectionObserver 接管自动播放
function autoPlayNext(el){
  const items = libItems();
  const i = +el.dataset.i;
  let next = items[i + 1];
  if(!next){
    // 当前页已到底：还有更多就先加载下一页，再滚到新出现的那条
    if(state.lib.has_more && !state.lib.loading){
      loadLibrary(false).then(()=>{
        const items2 = libItems();
        const n2 = items2[i + 1];
        if(n2) n2.scrollIntoView({behavior:'smooth'});
      }).catch(()=>{});
    }
    return;
  }
  next.scrollIntoView({behavior:'smooth'});
}

// 设置变更后，把已渲染视频的 loop / 倍速同步一遍（倍速不覆盖正在长按加速的那条）
function applyLibPlayback(){
  libItems().forEach(el=>{
    const v = el.querySelector('video'); if(!v) return;
    v.loop = !state.lib.autoNext;
    if(!el.classList.contains('speeding')) v.playbackRate = state.lib.speed;
  });
}

// ---- 播放中的各种提示与进度条绘制 ----
function paintLibProg(el, v){
  const p = (v.duration ? v.currentTime / v.duration : 0) * 100;
  const fill = el.querySelector('.lp-track i');
  const knob = el.querySelector('.lp-knob');
  if(fill) fill.style.width = Math.max(0, Math.min(100, p)) + '%';
  if(knob) knob.style.left = Math.max(0, Math.min(100, p)) + '%';
  const tip = el.querySelector('.lp-tip');
  if(tip) tip.innerHTML = `<b>${fmtDur(v.currentTime)}</b> / ${fmtDur(v.duration||0)}`;
  const seek = el.querySelector('.lib-seek .lsk-t');
  if(seek && el.classList.contains('seeking'))
    seek.innerHTML = `<b>${fmtDur(v.currentTime)}</b> / ${fmtDur(v.duration||0)}`;
}

function paintLibSeek(el, v, delta){
  const box = el.querySelector('.lib-seek'); if(!box) return;
  box.classList.toggle('back', delta < -0.5);
  box.classList.toggle('fwd', delta > 0.5);
  const t = box.querySelector('.lsk-t');
  if(t) t.innerHTML = `<b>${fmtDur(v.currentTime)}</b> / ${fmtDur(v.duration||0)}` +
    (Math.abs(delta) >= 1 ? ` <em>${delta>0?'+':''}${Math.round(delta)}s</em>` : '');
}

function showLibTip(text){
  const t = $('#libTip'); if(!t) return;
  t.innerHTML = text; t.hidden = false;
}
function hideLibTip(){ const t = $('#libTip'); if(t){ t.hidden = true; } }

function libOpen(el){
  const it = state.lib.items[+el.dataset.i]; if(!it) return;
  window.open(it.url || ('/api/media/stream?path=' + encodeURIComponent(it.path)), '_blank');
}

// 全屏：优先 requestFullscreen 保住自定义 UI（进度条/侧栏）；
// 不支持真正的全屏（iPhone Safari 无 requestFullscreen）时，用 CSS 全屏覆盖视口，
// 而不是退化到系统原生视频播放器——原生播放器会接管整个屏幕、丢失我们的进度条/侧栏/手势。
function toggleLibFullscreen(el){
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  const cssFs = el.classList.contains('lib-fs');
  if(fsEl){
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if(exit) exit.call(document).catch(()=>{});
    return;
  }
  if(cssFs){ el.classList.remove('lib-fs'); return; }
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if(req){
    const p = req.call(el);
    if(p && p.catch) p.catch(()=>{ el.classList.add('lib-fs'); });  // 失败 → CSS 全屏，绝不进原生播放器
  } else {
    el.classList.add('lib-fs');   // 无 requestFullscreen（iPhone）→ 直接 CSS 全屏
  }
}

// 进入视口的自动播放 / 离开即停：一次只播一个，滑动切换才跟手
function setupLibObserver(){
  if(libObs) libObs.disconnect();
  const feed = $('#libFeed');
  libObs = new IntersectionObserver(entries=>{
    entries.forEach(en=>{
      const el = en.target;
      const v = el.querySelector('video');
      if(!v) return;
      if(en.isIntersecting && en.intersectionRatio >= 0.6){
        const ni = +el.dataset.i;
        if(ni !== state.lib.index){ state.lib.index = ni; refreshPreload(ni); }
        v.muted = state.lib.mute;
        v.playbackRate = state.lib.speed;   // 按设置的默认倍速起播
        const p = v.play();
        if(p && p.catch) p.catch(()=> el.classList.add('paused'));
      } else if(!v.paused){
        v.pause();
      }
    });
  }, {root: feed, threshold: [0.35, 0.6, 0.9]});
  libItems().forEach(el=> libObs.observe(el));
  refreshPreload(state.lib.index);   // 首屏就把前后几条暖好
}

function stopLibrary(){
  libItems().forEach(el=>{
    const v = el.querySelector('video');
    if(v && !v.paused) v.pause();
  });
  if(libObs){ libObs.disconnect(); libObs = null; }
}

// 预加载：把当前条前后几条视频的缓冲先暖起来，滑动切换时才能即时播放
// 仅在窗口内（前 1 + 当前 + 后 2）设为 auto 并触发 load()；窗口外的设为 none 省带宽
let _preloadKey = '';
function refreshPreload(i){
  const arr = libItems();
  if(!arr.length) return;
  const lo = Math.max(0, i - 1);
  const hi = Math.min(arr.length - 1, i + LIB_PRELOAD_AHEAD);
  const key = lo + '-' + hi;
  if(key === _preloadKey) return;     // 窗口没变就不动，避免反复 load 浪费流量
  _preloadKey = key;
  arr.forEach((el, idx)=>{
    const v = el.querySelector('video');
    if(!v) return;
    if(idx >= lo && idx <= hi){
      if(v.preload !== 'auto') v.preload = 'auto';
      if(v.readyState < 1){ try{ v.load(); }catch(e){} }   // 还没加载过的才暖缓冲
      el.classList.add('preloading');
      if(idx !== i) primeLibVideo(el, v);   // 预热相邻视频缓冲，滑到时即时起播、不再卡
    } else {
      if(v.preload !== 'none') v.preload = 'none';
      el.classList.remove('preloading');
      v.dataset.priming = '';   // 移出窗口，下回再进入时允许重新预热
    }
  });
}

// 预热相邻视频：iOS Safari 直接忽略 preload，只有真正 play 才开始缓冲，
// 所以滑到下一条前它永远是空的、起播要等缓冲——这正是「起播慢」的根因。
// 这里静音 play 一下、等 playing 后再 pause，把开头几秒缓冲到本地，
// 滑到时就能即时起播。当前正在看的视频（idx===i）由观察器负责真正播放，不在此预热。
function primeLibVideo(el, v){
  if(el.dataset.priming) return;
  if(v.readyState >= 2) return;                       // 已有可播数据，无需再预热
  if(v.networkState === 1 && v.readyState >= 1) return; // 正在加载中
  el.dataset.priming = '1';
  v.muted = true;
  const onPlay = ()=>{
    v.removeEventListener('playing', onPlay);
    // 缓冲已经启动，停住别真播，等用户滑到再播；
    // 但若此刻它已变成正在看的那条，就让它继续播（不要抢着暂停）
    setTimeout(()=>{
      if(state.lib.index === +el.dataset.i && !v.paused) return;
      try{ v.pause(); }catch(_){}
    }, 80);
  };
  v.addEventListener('playing', onPlay);
  try{
    const p = v.play();
    if(p && p.catch) p.catch(()=>{ v.removeEventListener('playing', onPlay); el.dataset.priming = ''; });
  }catch(_){ el.dataset.priming = ''; }
}

// 进度落库：离结尾 15 秒内视为看完，归零下次从头播
function saveLibProgress(el){
  const v = el.querySelector('video');
  const it = state.lib.items[+el.dataset.i];
  if(!v || !it || !v.duration) return;
  const pos = (v.duration - v.currentTime < 15) ? 0 : v.currentTime;
  if(Math.abs((it.position||0) - pos) < 2) return;
  it.position = pos;
  api('/media/meta',{method:'POST',
    body:JSON.stringify({path:it.path, position:pos, duration:v.duration})});
}

function libStar(el, burst){
  const it = state.lib.items[+el.dataset.i]; if(!it) return;
  it.star = !it.star;
  const b = el.querySelector('.lsb.star');
  if(b) b.classList.toggle('on', it.star);
  el.classList.toggle('starred', it.star);
  if(burst && it.star){
    const h = el.querySelector('.lib-burst');
    if(h){ h.classList.add('go'); setTimeout(()=>h.classList.remove('go'), 420); }
  }
  // 顶部「♥ 收藏」的计数跟着变，不然要等下次刷新才对
  state.lib.starCount = Math.max(0, (state.lib.starCount||0) + (it.star ? 1 : -1));
  renderLibCats();
  api('/media/meta',{method:'POST',body:JSON.stringify({path:it.path, star:it.star})});
  if(!burst) toast(it.star? '已收藏 ♥' : '已取消收藏');
}

function libToggleMute(){
  state.lib.mute = !state.lib.mute;
  localStorage.setItem('twixive.libMute', state.lib.mute ? '1' : '0');
  libItems().forEach(el=>{
    const v = el.querySelector('video');
    if(v) v.muted = state.lib.mute;
  });
  applyLibMuteUI();
  toast(state.lib.mute ? '已静音' : '已取消静音');
}

function applyLibMuteUI(){
  const m = state.lib.mute;
  libItems().forEach(el=>{
    const b = el.querySelector('.lsb[data-act="mute"]');
    if(b){
      const lb = b.querySelector('.ls-n'); if(lb) lb.textContent = m ? '已静音' : '静音';
      b.classList.toggle('on', m);   // 图标由 CSS 按 .on 切换 sound / mute 两套 svg
    }
  });
}

function libCopyLink(el){
  const it = state.lib.items[+el.dataset.i]; if(!it) return;
  const txt = it.url || (location.origin + '/api/media/stream?path=' + encodeURIComponent(it.path));
  if(navigator.clipboard) navigator.clipboard.writeText(txt).then(()=> toast('已复制链接'), ()=> toast('复制失败'));
  else toast(txt);
}

async function libDelete(el){
  const i = +el.dataset.i;
  const it = state.lib.items[i]; if(!it) return;
  if(!confirm('删除视频文件？\n\n' + it.title + '\n' + fmtGB(it.size) +
              '\n\n文件将移入回收站，可在「回收站」恢复或彻底删除。')) return;
  const v = el.querySelector('video'); if(v) v.pause();
  const r = await api('/media?path='+encodeURIComponent(it.path), {method:'DELETE'});
  toast(r.freed ? ('已删除，释放 '+fmtGB(r.freed)) : '磁盘上已没有该文件，仅清理了记录');
  el.remove();
  state.lib.items.splice(i, 1);
  libItems().forEach((n,k)=>{ n.dataset.i = k; });
  state.lib.all = Math.max(0, state.lib.all - 1);
  const c = state.lib.cats.find(x=>x.name === it.category);
  if(c) c.count = Math.max(0, c.count - 1);
  if(it.star) state.lib.starCount = Math.max(0, state.lib.starCount - 1);
  if(libItems().length){
    renderLibCats();
    updateLibEmpty();
    setupLibObserver();
  } else {
    loadLibrary(true);
  }
  loadStorage(false);
  loadTasks();
}

function libScrollTo(i){
  const arr = libItems();
  if(i < 0) i = 0;
  if(i >= arr.length){
    if(state.lib.has_more){ state.lib.page++; loadLibrary(false); }
    return;
  }
  arr[i].scrollIntoView({behavior:'smooth', block:'start'});
}

function renderLibCats(){
  const box = $('#libCats'); const L = state.lib;
  const chips = [{name:'', label:'全部', count:L.all, main:true},
                 {name:'__star__', label:'收藏', count:L.starCount, main:true}]
    .concat(L.cats.map(c=>({name:c.name, label:c.label, count:c.count, main:false})));
  box.innerHTML = chips.map(c=>{
    const active = c.name === '__star__' ? L.starOnly : (!L.starOnly && L.cat === c.name);
    // minor = 除「全部 / 收藏」以外的分类，手机端顶栏只留前两个
    const cls = 'lib-cat' + (active ? ' active' : '') + (c.main ? '' : ' minor');
    return `<button class="${cls}" data-cat="${esc(c.name)}">${esc(c.label)}<span class="lc-n">${c.count}</span></button>`;
  }).join('');
  $$('.lib-cat', box).forEach(b=> b.onclick = ()=>{
    const n = b.dataset.cat;
    if(n === '__star__'){ L.starOnly = true; L.cat = ''; }
    else { L.starOnly = false; L.cat = n; }
    loadLibrary(true);
  });
}

function updateLibEmpty(){
  const L = state.lib;
  const has = libItems().length > 0;
  $('#libEmpty').hidden = has;
  if(!has){
    $('#libEmpty').querySelector('p').textContent =
      L.all === 0 ? '视频库还是空的'
                  : (L.starOnly ? '还没有收藏的视频' : '这个筛选下没有视频');
  }
}

$('#libBack').onclick = ()=> $('.nav[data-view="dashboard"]').click();
localStorage.removeItem('twixive.libMode');   // 网格视图已移除，清掉旧的模式记录
setupLibObserver();
$('#libSort').onclick = ()=>{
  const i = LIB_SORTS.findIndex(s=>s[0] === state.lib.sort);
  const nx = LIB_SORTS[(i+1) % LIB_SORTS.length];
  state.lib.sort = nx[0];
  // 进入随机：每次都重新生成一个种子，得到一份全新的洗牌顺序
  if(nx[0] === 'random'){
    state.lib.seed = String(Math.floor(Math.random()*1e12));
  }
  $('#libSort').title = '当前排序：' + nx[1] + '（点击切换）';
  toast('排序：' + nx[1]);
  loadLibrary(true);
};
let libSearchTimer = null;
$('#libSearch').addEventListener('input', e=>{
  clearTimeout(libSearchTimer);
  const val = e.target.value.trim();
  libSearchTimer = setTimeout(()=>{ state.lib.q = val; loadLibrary(true); }, 400);
});
$('#libFeed').addEventListener('scroll', ()=>{
  const f = $('#libFeed'); const L = state.lib;
  if(!L.has_more || L.loading) return;
  if(f.scrollTop + f.clientHeight*2 >= f.scrollHeight){ L.page++; loadLibrary(false); }
});
document.addEventListener('keydown', e=>{
  if($('#view-library').classList.contains('hidden')) return;
  if(['INPUT','TEXTAREA'].includes((document.activeElement||{}).tagName)) return;
  if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    e.preventDefault();
    libScrollTo(state.lib.index + (e.key === 'ArrowDown' ? 1 : -1));
  } else if(e.key === 'ArrowRight' || e.key === 'ArrowLeft'){
    const el = libItems()[state.lib.index];
    const v = el && el.querySelector('video');
    if(v && v.duration){
      e.preventDefault();
      try{ v.currentTime = Math.max(0, Math.min(v.duration,
        v.currentTime + (e.key === 'ArrowRight' ? 10 : -10))); }catch(_){}
      showLibTip(fmtDur(v.currentTime) + ' / ' + fmtDur(v.duration));
      clearTimeout(window.__libTipT);
      window.__libTipT = setTimeout(hideLibTip, 900);
    }
  } else if(e.key === ' '){
    e.preventDefault();
    const el = libItems()[state.lib.index];
    const v = el && el.querySelector('video');
    if(v) v.paused ? v.play().catch(()=>{}) : v.pause();
  } else if(e.key === 'm'){ libToggleMute(); }
  else if(e.key === 'f'){
    const el = libItems()[state.lib.index];
    if(el) libStar(el, true);
  }
});

// ---- 预览弹窗 ----
function openPreview(item){
  const m=$('#previewModal'); m.classList.remove('hidden');
  $('#pvTitle').textContent = item.title || '预览';
  const v=$('#pvVideo');
  v.src = item.url || '';
  v.play().catch(()=>{});
  $('#pvFoot').textContent = catLabel(item.category);
}
$$('#previewModal [data-close]').forEach(x=>x.onclick=()=>{
  $('#previewModal').classList.add('hidden');
  const v=$('#pvVideo'); v.pause(); v.removeAttribute('src'); v.load();
});

// ---- 设置保存 ----
$('#btnSaveSettings').onclick=async()=>{
  const patch={
    proxy_url:$('#proxy_url').value.trim(),
    proxy_enabled:$('#proxy_enabled').checked,
    concurrent:+$('#concurrent').value||1, rate_delay:+$('#rate_delay').value||0,
    retry_times:+$('#retry_times').value||0, max_size_mb:+$('#max_size_mb').value||0,
    default_playback_rate: parseFloat($('#default_playback_rate').value)||1,
    auto_play_next: $('#auto_play_next').checked,
    auto_enabled:$('#auto_enabled').checked, auto_interval:+$('#auto_interval').value||60
  };
  state.settings=await api('/settings',{method:'POST',body:JSON.stringify(patch)});
  state.lib.speed = state.settings.default_playback_rate || 1;
  state.lib.autoNext = !!state.settings.auto_play_next;
  applyLibPlayback();
  updateProxyChip();
  updateHud(state.tasks);
  toast('设置已保存');
};
// 代理总开关：改完立刻生效，不必再去点「保存设置」
$('#proxy_enabled').onchange=async()=>{
  const on=$('#proxy_enabled').checked;
  state.settings=await api('/settings',{method:'POST',body:JSON.stringify({proxy_enabled:on})});
  updateProxyChip();
  updateHud(state.tasks);
  toast(on? '代理已启用（抓取与下载走代理）' : '代理已关闭，全部走直连');
};

// ---- 代理连通性自检（从面板所在机器发起，结果最准）----
$('#btnProxyTest').onclick=async()=>{
  const out=$('#proxyTestOut'); const btn=$('#btnProxyTest');
  if(!out||!btn) return;
  btn.disabled=true; out.hidden=false; out.textContent='正在从服务器测试…';
  try{
    const r=await api('/proxy/test',{method:'POST'});
    let txt = r.ok ? '✅ '+r.message : '❌ '+r.message;
    if(r.ms) txt += '（'+r.ms+' ms）';
    const d=r.direct;
    if(d) txt += '\n' + (d.ok ? `直连可用（${d.ms} ms）` : `直连也不可用：${d.error||'未知'}`);
    if(!r.ok && d && d.ok) txt += '\n→ 是代理本身的问题，换一个代理地址即可。';
    if(!r.ok && d && !d.ok) txt += '\n→ 代理和直连都不通，是这台机器到外网的网络问题。';
    out.textContent = txt;
    out.className = 'hint' + (r.ok?' ok':' bad');
  }catch(e){ out.textContent='测试失败：'+e; out.className='hint bad'; }
  finally{ btn.disabled=false; }
};

init();
