(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const modes = { priority: '优先携带', relevant: '按话题回忆', off: '不发送' };
  const statuses = { remembered: '记在心里', pending: '等待兑现', completed: '已经完成', changed: '计划有变' };
  const state = { api: null, characters: [], characterId: '', entries: [], categories: [], settings: null, limit: 20, revision: 0, editing: null, deleting: null, busy: false };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const date = value => { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '日期未记录'; };
  const error = err => err?.message || String(err);
  function busy(value) {
    state.busy = value;
    $('character').disabled = value || !state.characters.length;
    $('refresh').disabled = value;
    $('organize').disabled = value || !state.characterId || !state.settings?.enabled;
    document.querySelectorAll('#cards button').forEach(button => { button.disabled = value; });
  }
  function notice(value, failed = false) { $('notice').textContent = value; $('notice').dataset.error = String(failed); }
  function renderSettings() {
    const form = $('settings');
    for (const [key, value] of Object.entries(state.settings || {})) {
      const field = form.elements.namedItem(key);
      if (!field) continue;
      if (field.type === 'checkbox') field.checked = value;
      else field.value = value;
    }
  }
  function render() {
    const query = $('search').value.trim().toLocaleLowerCase();
    const category = $('category').value, mode = $('mode-filter').value;
    const entries = state.entries.filter(entry => {
      const d = entry.shiguang;
      return (!category || d.categories.includes(category)) && (!mode || mode === d.recallMode)
        && (!query || [d.title, entry.content, entry.promptText, d.reason, d.story, d.followup, ...d.keywords, ...d.details.map(f => f.label + f.value)].join(' ').toLocaleLowerCase().includes(query));
    });
    $('count').textContent = `${entries.length} 条记忆${query || category || mode ? ' · 已筛选' : ''}`;
    $('more').hidden = entries.length <= state.limit;
    $('cards').innerHTML = entries.slice(0, state.limit).map(entry => {
      const d = entry.shiguang;
      const fields = [['事情的缘由',d.reason],['那天发生了什么',d.story],...d.details.map(f=>[f.label,f.value]),['值得记住的',d.significance],['后来发生了什么',d.followup]];
      return `<article class="card" data-id="${esc(entry.id)}"><div class="card-meta"><time>${esc(date(d.lastEventAt))}</time><span class="badge">${esc(modes[d.recallMode])}</span></div><h3>${esc(d.title)}</h3><p class="summary">${esc(entry.content)}</p><div class="tags">${d.categories.map(c=>`<span class="tag">${esc(c)}</span>`).join('')}</div><div class="prompt-block"><div class="prompt-head"><span>选中后发给 AI 的内容</span><small>约 ${entry.promptTokens} Token</small></div><p class="prompt-text">${esc(entry.promptText)}</p>${d.recallMode === 'off' ? '<p class="budget-note">这条已设为不发送。</p>' : entry.promptTokens > state.settings.tokenBudget ? '<p class="budget-note">这条超过当前预算，会被整条跳过。可编辑摘要或调整预算。</p>' : ''}</div><details><summary>展开故事与具体信息</summary><dl class="facts">${fields.filter(([,v])=>v).map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}<dt>当前进展</dt><dd>${esc(statuses[d.status])}${d.dueAt ? ' · '+esc(d.dueAt) : ''}</dd><dt>回忆关键词</dt><dd>${esc(d.keywords.join('、') || '未设置')}</dd></dl></details><div class="actions"><button class="primary" data-action="edit">编辑与摘要</button><button class="quiet" data-action="sources">回看原消息</button><button class="danger" data-action="delete" aria-label="删除${esc(d.title)}">删除</button></div></article>`;
    }).join('') || `<p class="empty">${state.entries.length ? '没有找到这段记忆，试试其他关键词或筛选。' : '这里还没有拾光。点击「整理新消息」，从已有聊天接着整理。'}</p>`;
    busy(state.busy);
  }
  async function load() {
    if (!state.characterId) { $('cards').innerHTML = '<p class="empty">先在小手机创建一个角色，再来收藏共同经历。</p>'; return; }
    const revision = ++state.revision;
    const characterId = state.characterId;
    busy(true); notice(''); $('cards').innerHTML='<p class="empty">正在翻开记忆本…</p>';
    try {
      const result = await state.api.memory.readShiguang({ characterId });
      if (revision !== state.revision || characterId !== state.characterId) return;
      state.entries = result.entries; state.settings = result.settings; state.categories = result.categories; state.limit = 20;
      const category = $('category').value;
      $('category').innerHTML = '<option value="">全部类型</option>' + state.categories.map(c=>`<option>${esc(c)}</option>`).join('');
      $('category').value = state.categories.includes(category) ? category : '';
      renderSettings(); render();
      if (!state.settings.enabled) notice('拾光已关闭：记录仍保留，暂停整理和发送。可在「回忆规则」开启。');
    } catch (err) { notice(error(err), true); }
    finally { if (revision === state.revision) busy(false); }
  }
  function input(name, label, value, max = 1200, rows = 3) {
    return `<label>${esc(label)}<textarea name="${name}" maxlength="${max}" rows="${rows}" ${['title','content','promptSummary'].includes(name) ? 'required' : ''}>${esc(value)}</textarea></label>`;
  }
  function showEditor(entry) {
    state.editing = entry;
    const d = entry.shiguang;
    $('edit-fields').innerHTML = `<section class="edit-section"><h3>供 AI 回忆的摘要</h3><p class="muted">保留人名、具体物品或作品名、关键行为、日期与约定。进展和后续会自动附在摘要之后。</p><div class="fields">${input('promptSummary','摘要正文',d.promptSummary,12000,7)}<label>发送方式<select name="recallMode">${Object.entries(modes).map(([v,k])=>`<option value="${v}" ${d.recallMode===v?'selected':''}>${k}</option>`).join('')}</select></label><label>回忆关键词（用顿号或逗号隔开，最多 8 个）<input name="keywords" value="${esc(d.keywords.join('、'))}"></label></div><button type="button" class="quiet wide" id="regenerate-summary">从下方卡片内容重新生成摘要</button><small>这会替换上方编辑框中的摘要，保存前不会改变记录。</small></section><details><summary>编辑故事与具体信息</summary><div class="fields">${input('title','标题',d.title,60,1)}${input('content','卡片简述',entry.content,200)}${input('reason','事情的缘由',d.reason)}${input('story','那天发生了什么',d.story)}${input('facts','具体信息（每行：名称：内容）',d.details.map(f=>f.label+'：'+f.value).join('\n'),5500)}${input('significance','值得记住的',d.significance,600)}<div><span>记忆类型（至少一种）</span><div class="check-group">${state.categories.map(c=>`<label><input type="checkbox" name="categories" value="${esc(c)}" ${d.categories.includes(c)?'checked':''}>${esc(c)}</label>`).join('')}</div></div></div></details><div class="fields"><label>当前进展<select name="status">${Object.entries(statuses).map(([v,k])=>`<option value="${v}" ${d.status===v?'selected':''}>${k}</option>`).join('')}</select></label><label id="due-field">约定日期<input type="date" name="dueAt" value="${esc(d.dueAt || '')}"></label>${input('followup','后来发生了什么',d.followup,1000)}</div>`;
    const form = $('edit-form');
    const syncDate = () => { $('due-field').hidden = form.elements.status.value !== 'pending'; };
    form.elements.status.onchange = syncDate; syncDate();
    $('regenerate-summary').onclick = () => {
      const draft = draftFromForm();
      const parts = [draft.title,draft.content,draft.reason,draft.story,...draft.details.map(f=>f.label+'：'+f.value),draft.significance].map(v=>v.trim()).filter(Boolean);
      form.elements.promptSummary.value = parts.filter((p,i)=>!parts.some((other,j)=>i!==j&&other.includes(p)&&(other.length>p.length||j<i))).join('；');
    };
    $('edit-error').textContent = '';
    $('editor').showModal();
    $('editor').scrollTop = 0;
  }
  function draftFromForm() {
    const form = $('edit-form'), fd = new FormData(form), draft = Object.fromEntries(fd);
    draft.categories = fd.getAll('categories');
    draft.keywords = String(draft.keywords || '').split(/[,，、\n]+/).map(v=>v.trim()).filter(Boolean);
    draft.details = String(draft.facts || '').split('\n').map(v=>v.trim()).filter(Boolean).map(line=>{
      const i=line.search(/[：:]/); return i>0 ? {label:line.slice(0,i).trim(),value:line.slice(i+1).trim()} : {label:'补充',value:line};
    });
    return draft;
  }
  async function save(event) {
    event.preventDefault();
    const entry = state.editing;
    if (!entry || $('save-entry').disabled) return;
    $('save-entry').disabled = true; $('close-editor').disabled = true; $('edit-error').textContent = '';
    try {
      const updated = await state.api.memory.saveShiguang({ characterId:entry.characterId,id:entry.id,expectedUpdatedAt:entry.updatedAt,draft:draftFromForm() });
      state.entries = state.entries.map(e=>e.id===updated.id?updated:e);
      $('editor').close(); render(); notice('记忆和摘要已保存。下次选中时使用卡片中显示的内容。');
    } catch(err) { $('edit-error').textContent=error(err); }
    finally { $('save-entry').disabled=false; $('close-editor').disabled=false; }
  }
  async function sources(entry) {
    $('source-list').innerHTML='<p class="empty">正在寻找原消息…</p>'; $('sources').showModal();
    try {
      const list=await state.api.memory.shiguangSources({characterId:entry.characterId,id:entry.id});
      $('source-list').innerHTML=list.map(item=>`<article class="source"><small>${esc(date(item.timestamp))} · ${item.authorType==='user'?'你':'角色'}</small><p>${esc(item.content)}</p></article>`).join('') || '<p class="empty">关联的原消息已不在本机，记忆仍保留。</p>';
    } catch(err) { $('source-list').textContent=error(err); }
  }
  $('cards').onclick=event=>{
    const button=event.target.closest('button[data-action]'); if(!button||state.busy)return;
    const entry=state.entries.find(e=>e.id===button.closest('[data-id]').dataset.id); if(!entry)return;
    if(button.dataset.action==='edit')showEditor(entry);
    if(button.dataset.action==='sources')void sources(entry);
    if(button.dataset.action==='delete'){state.deleting=entry;$('delete-error').textContent='';$('delete-dialog').showModal();}
  };
  $('confirm-delete').onclick=async()=>{
    const entry=state.deleting;if(!entry||$('confirm-delete').disabled)return;
    $('confirm-delete').disabled=true;$('cancel-delete').disabled=true;
    try {
      await state.api.memory.deleteShiguang({characterId:entry.characterId,id:entry.id,expectedUpdatedAt:entry.updatedAt});
      state.entries=state.entries.filter(e=>e.id!==entry.id);$('delete-dialog').close();render();notice('这条拾光已删除，原聊天消息保留。');
    } catch(err){$('delete-error').textContent=error(err);}
    finally{$('confirm-delete').disabled=false;$('cancel-delete').disabled=false;}
  };
  $('cancel-delete').onclick=()=>$('delete-dialog').close();
  $('close-editor').onclick=()=>$('editor').close();
  $('close-sources').onclick=()=>$('sources').close();
  $('editor').addEventListener('cancel',event=>{if($('save-entry').disabled)event.preventDefault();});
  $('delete-dialog').addEventListener('cancel',event=>{if($('confirm-delete').disabled)event.preventDefault();});
  $('edit-form').onsubmit=save;
  $('character').onchange=()=>{state.characterId=$('character').value;state.entries=[];void load();};
  $('refresh').onclick=()=>void (state.characters.length ? load() : start());
  for(const id of ['search','category','mode-filter'])$(id).addEventListener(id==='search'?'input':'change',()=>{state.limit=20;render();});
  $('more').onclick=()=>{state.limit+=20;render();};
  document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{
    document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-current',b===button?'page':'false'));
    $('memories').hidden=button.dataset.tab!=='memories';$('rules').hidden=button.dataset.tab!=='rules';
  });
  $('organize').onclick=async()=>{
    if(state.busy)return;busy(true);$('organize').textContent='正在整理…';notice('正在调用记忆模型，完成前请保持页面打开。');
    try {
      const result=await state.api.memory.organizeShiguang({characterId:state.characterId});
      if(!result.success)throw new Error(result.error||'整理失败，请重试');
      await load();notice(`整理完成，保存 ${result.saved || 0} 条。${result.hasMore?'还有未整理的消息，可再点一次继续。':''}`);
    } catch(err){notice(error(err), true);}
    finally{busy(false);$('organize').textContent='整理新消息';}
  };
  $('settings').onsubmit=async event=>{
    event.preventDefault();const form=$('settings'),button=form.querySelector('button[type=submit]');if(button.disabled)return;
    button.disabled=true;$('settings-notice').textContent='';
    try {
      state.settings=await state.api.memory.configureShiguang({enabled:form.elements.enabled.checked,autoEnabled:form.elements.autoEnabled.checked,roundInterval:Number(form.elements.roundInterval.value),tokenBudget:Number(form.elements.tokenBudget.value)});
      render();$('settings-notice').textContent='已保存，所有角色使用这组拾光设置。';
    } catch(err){$('settings-notice').textContent=error(err);}
    finally{button.disabled=false;}
  };
  async function start() {
    state.api=window.AiPhone;
    if(!state.api?.memory?.readShiguang){notice('这个版本的小手机还不支持独立拾光。请先更新宿主，再重新打开；原记忆仍保留。');$('cards').innerHTML='';$('settings').querySelector('button[type=submit]').disabled=true;$('refresh').disabled=true;return;}
    busy(true);
    try {
      const [characters,launch,config]=await Promise.all([state.api.characters.list(),state.api.app.getLaunchContext(),state.api.memory.shiguangSettings()]);
      state.characters=Array.isArray(characters)?characters:characters.characters||[];state.settings=config;renderSettings();
      $('character').innerHTML=state.characters.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')||'<option value="">还没有角色</option>';
      state.characterId=state.characters.some(c=>c.id===launch?.characterId)?launch.characterId:state.characters[0]?.id||'';
      $('character').value=state.characterId;await load();
    } catch(err){notice(error(err), true);$('cards').innerHTML='<p class="empty">记忆未能读取，点击刷新重试。</p>';}
    finally{busy(false);}
  }
  void start();
})();
