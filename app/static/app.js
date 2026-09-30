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
  knownUrls: new Set()   // 已存在/已入队过的视频地址，用于自动跳过重复
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
  const delTitle = (state.purge && t.path) ? '删除任务，并删除源文件（不可恢复）' : '只删除任务记录';
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
          if(!confirm('删除任务「'+(t.title||'')+'」\n并删除源文件（'+(t.size?fmtSize(t.size):'文件')+'）？\n\n文件删除不可恢复。若只想删记录，先取消勾选「删除时同时删源文件」。')) return;
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
    if(!confirm('清除 '+done.length+' 条已结束任务，并删除它们的源文件（约 '+fmtGB(sz)+'）？\n\n文件删除不可恢复。')) return;
  }
  const r=await api('/tasks/clear'+(purge?'?purge=1':''),{method:'POST'});
  toast('已清除 '+done.length+' 条'+(r.freed?('，释放 '+fmtGB(r.freed)):''));
  loadStorage(false);
  loadTasks();
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
  // 存储占用（后端扫盘统计，30s 缓存）
  const sto = state.storage || {};
  const disk = sto.disk || {};
  const storeTxt = (sto.bytes!=null) ? fmtGB(sto.bytes) : '—';
  const storeSub = (sto.bytes!=null)
    ? `${sto.files||0} 个文件` + (disk.free!=null? ` · 剩余 ${fmtGB(disk.free)}` : '')
    : '读取中…';
  $('#stats').innerHTML=`
    <div class="stat s1"><div class="ic">⏳</div><div class="n">${c.pending}</div><div class="l">等待中</div></div>
    <div class="stat s2"><div class="ic">⬇</div><div class="n">${c.downloading}</div><div class="l">下载中</div></div>
    <div class="stat s3"><div class="ic">✅</div><div class="n">${c.done}</div><div class="l">已完成</div></div>
    <div class="stat s4"><div class="ic">⚠️</div><div class="n">${c.error}</div><div class="l">失败</div></div>
    <div class="stat s5"><div class="ic">📡</div><div class="n">${mon}</div><div class="l">监控中分类</div></div>
    <div class="stat s6" title="下载目录 ${esc(sto.path||'')} 的真实磁盘占用${disk.total!=null?(' · 磁盘共 '+fmtGB(disk.total)):''}">
      <div class="ic">💾</div><div class="n">${storeTxt}</div><div class="l">总占用 · ${storeSub}</div></div>`;
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
    auto_enabled:$('#auto_enabled').checked, auto_interval:+$('#auto_interval').value||60
  };
  state.settings=await api('/settings',{method:'POST',body:JSON.stringify(patch)});
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
