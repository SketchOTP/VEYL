import { icon } from './icons.js';
import { TypeIcons } from './file-type-icons.js';
import { initializeSettings } from './settings.js';

const api = window.systemus;
const typeIcons = new TypeIcons(api.fileIcons);
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const withIcon = (node, type) => { node.insertAdjacentHTML('afterbegin', icon(type)); return node; };
for (const node of $$('[data-icon]')) withIcon(node, node.dataset.icon);
function graphicAction(node, label, type = null, tooltip = label) {
  node.replaceChildren(el('span', 'sr-only', label));
  if (type) withIcon(node, type);
  node.classList.add('graphic-action'); node.setAttribute('aria-label', label); node.title = tooltip;
  return node;
}
for (const [id, label, type, tooltip] of [['new-folder','New folder','plus','New folder (Ctrl+Shift+N)'],['paste','Paste','paste','Paste (Ctrl+V)'],['undo','Undo','undo','Undo (Ctrl+Z)'],['rename','Rename','rename','Rename (F2)'],['delete','Trash','trash','Move to recoverable Trash (Delete)'],['chat-toggle','VEYL','sparkle','Toggle VEYL']]) graphicAction($('#'+id),label,type,tooltip);

function bytes(value) {
  if (value === undefined || value === null) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB']; let number = value / 1024, unit = 0;
  while (number >= 1024 && unit < units.length - 1) { number /= 1024; unit++; }
  return `${number.toFixed(number < 10 ? 1 : 0)} ${units[unit]}`;
}
const date = timestamp => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(timestamp);
const fullDate = timestamp => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
const basename = file => file === '/' ? 'Filesystem' : file.split('/').filter(Boolean).at(-1) || 'Home';
const parent = file => file === '/' ? '/' : file.slice(0, file.lastIndexOf('/')) || '/';
const typeLabel = entry => ({ folder: 'Folder', image: 'Image', audio: 'Audio', video: 'Video', archive: 'Archive', pdf: 'PDF document', symlink: 'Symbolic link', text: 'Text document', special: 'Special file' }[entry.type] || (entry.extension ? `${entry.extension.toUpperCase()} file` : 'File'));

let boot;
let bookmarks = [];
let view = 'grid', density = 'comfortable', hidden = false, dual = false, recursive = false;
let activePane = null, secondary = null, selectedTab = null;
let clipboard = null, busy = false, inspectorVersion = 0, inspectorTimer;
let tabs = [];
let chatJob = null, chatSnapshot = null, chatAvailable = false, chatApplying = false, chatScope = null, chatPlan = null;
let dialogResolver = null;
const thumbnailCache = new Map();
let thumbnailRunning = 0;
const thumbnailQueue = [];
const paneMap = new Map();

function toast(message, error = false, persistent = false) {
  const node = withIcon(el('div', `toast${error ? ' error' : ''}`), error ? 'warning' : 'check');
  if (!error && !persistent) node.classList.add('transient-success');
  node.append(el('span', '', message));
  const close = withIcon(el('button'), 'close'); close.setAttribute('aria-label', 'Dismiss notification'); close.onclick = () => node.remove(); node.append(close);
  $('#toast-container').append(node);
  // Recent successes are enough; actionable failures stay available until their own dismissal/timeout.
  const successes = $$('#toast-container .transient-success');
  for (const older of successes.slice(0, -2)) older.remove();
  if (!persistent) setTimeout(() => node.remove(), error ? 9000 : 4500);
}

function newPane(file) {
  const pane = { id: crypto.randomUUID(), path: file, entries: [], total: 0, nextOffset: null, selection: new Set(), anchor: -1, focused: null, history: [file], historyIndex: 0, sort: 'name', direction: 'asc', filter: '', version: 0, loading: false, search: null, listId: null };
  paneMap.set(pane.id, pane); return pane;
}
function paneElement(pane) { return pane === secondary ? $('#pane-secondary') : $('#pane-primary'); }

function currentEntries(pane = activePane) { return pane?.entries.filter(entry => pane.selection.has(entry.path)) || []; }
function savePreferences() {
  api.saveSettings({ bookmarks, preferences: { view, density, hidden, dualPane: dual } }).catch(error => toast(error.message, true));
}

function renderNavigation() {
  const renderGroup = (target, items, removable = false) => {
    target.replaceChildren();
    for (const item of items) {
      const button = withIcon(el('button', `nav-item${activePane?.path === item.path ? ' active' : ''}`), item.icon || 'star');
      button.append(el('span', 'nav-label', item.label)); button.title = `${item.label} · ${item.path}`; button.setAttribute('aria-label', item.label);
      button.onclick = () => navigate(activePane, item.path);
      if (removable) {
        const remove = withIcon(el('span', 'bookmark-remove'), 'close'); remove.title = 'Remove bookmark';
        remove.onclick = event => { event.stopPropagation(); bookmarks = bookmarks.filter(bookmark => bookmark.path !== item.path); renderNavigation(); savePreferences(); };
        button.append(remove);
      }
      target.append(button);
    }
  };
  renderGroup($('#places'), boot.places); renderGroup($('#mounts'), boot.mounts); renderGroup($('#bookmarks'), bookmarks, true);
  if (!bookmarks.length) { const empty = withIcon(el('div', 'bookmark-empty'), 'star'); empty.title = 'Bookmark a folder with the + control'; empty.setAttribute('aria-label', empty.title); $('#bookmarks').append(empty); }
  $('#trash-place').classList.toggle('active', activePane?.path === 'trash:');
}

function renderTabs() {
  $('#tabs').replaceChildren();
  for (const tab of tabs) {
    const button = withIcon(el('div', `folder-tab${tab.id === selectedTab ? ' active' : ''}`), tab.path === 'trash:' ? 'trash' : 'folder');
    button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(tab.id === selectedTab)); button.tabIndex = tab.id === selectedTab ? 0 : -1;
    button.append(el('span', 'tab-name', tab.path === 'trash:' ? 'Trash' : tab.path === boot.home ? 'Home' : basename(tab.path)));
    button.title = tab.path;
    button.onclick = () => selectTab(tab.id);
    button.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') selectTab(tab.id); };
    const close = withIcon(el('button', 'icon-button'), 'close'); close.setAttribute('aria-label', 'Close tab'); close.onclick = event => { event.stopPropagation(); closeTab(tab.id); };
    button.append(close); $('#tabs').append(button);
  }
}
function addTab(file = activePane?.path || boot.home) {
  const tab = newPane(file); tabs.push(tab); selectedTab = tab.id; setActive(tab); renderTabs(); load(tab); return tab;
}
function selectTab(id) {
  selectedTab = id; const tab = tabs.find(item => item.id === id); setActive(tab); renderPane(tab); renderTabs(); syncWatches();
}
function closeTab(id) {
  if (tabs.length === 1) return;
  const index = tabs.findIndex(tab => tab.id === id); const tab = tabs[index];
  if (tab.search && !tab.search.done) api.cancelSearch(tab.search.id).catch(() => {});
  if (tab.listId) api.cancelList(tab.listId).catch(() => {});
  tabs.splice(index, 1); paneMap.delete(id);
  if (id === selectedTab) selectTab(tabs[Math.max(0, index - 1)].id); else renderTabs();
}
function setActive(pane) {
  if (!pane) return;
  activePane = pane;
  $('#pane-primary').classList.toggle('active-pane', pane !== secondary);
  $('#pane-secondary').classList.toggle('active-pane', pane === secondary);
  updateToolbar(); renderNavigation();
}

function updateToolbar() {
  if (!activePane) return;
  const pane = activePane;
  $('#back').disabled = pane.historyIndex === 0;
  $('#forward').disabled = pane.historyIndex >= pane.history.length - 1;
  $('#up').disabled = pane.path === '/' || pane.path === 'trash:';
  $('#sort').value = pane.sort;
  $('#sort-direction').title = pane.direction === 'asc' ? 'Sort descending' : 'Sort ascending';
  $('#search-input').value = pane.search?.query || pane.filter;
  $('#cancel-search').hidden = !pane.loading && !(pane.search && !pane.search.done);
  $('#selection-actions').hidden = pane.selection.size === 0 || pane.path === 'trash:';
  graphicAction($('#rename'), pane.selection.size > 1 ? 'Batch rename' : 'Rename', 'rename', pane.selection.size > 1 ? 'Batch rename (F2)' : 'Rename (F2)');
  $('#paste').disabled = busy || pane.path === 'trash:' || Boolean(pane.search);
  $('#new-folder').disabled = busy || pane.path === 'trash:' || Boolean(pane.search);
  $('#undo').disabled = !$('#undo').dataset.available || busy;
  $('#breadcrumbs').replaceChildren();
  if (pane.path === 'trash:') $('#breadcrumbs').append(withIcon(el('button', '', 'Trash'), 'trash'));
  else {
    const components = pane.path.split('/').filter(Boolean);
    const homeParts = boot.home.split('/').filter(Boolean);
    const isHome = pane.path === boot.home || pane.path.startsWith(`${boot.home}/`);
    const parts = isHome ? [{ label: 'Home', path: boot.home, icon: 'home' }] : [{ label: '/', path: '/', icon: 'drive' }];
    const start = isHome ? homeParts.length : 0;
    for (let index = start; index < components.length; index++) parts.push({ label: components[index], path: `/${components.slice(0, index + 1).join('/')}` });
    const shown = parts.length > 4 ? [parts[0], { label: '…', path: parent(parts.at(-3).path) }, ...parts.slice(-3)] : parts;
    shown.forEach((part, index) => {
      if (index) { const separator = el('span'); separator.innerHTML = icon('right'); $('#breadcrumbs').append(separator.firstChild); }
      const button = el('button', '', part.label); if (part.icon) withIcon(button, part.icon);
      button.title = part.path; button.onclick = () => navigate(pane, part.path); $('#breadcrumbs').append(button);
    });
  }
  updateStatus();
  updateChatContext();
}
function updateStatus(extra) {
  if (!activePane) return;
  const pane = activePane;
  const selected = currentEntries(pane);
  let text = `${pane.total.toLocaleString()} items`;
  if (pane.entries.length < pane.total && !pane.search) text += ` · ${pane.entries.length.toLocaleString()} loaded`;
  if (selected.length) text += ` · ${selected.length} selected · ${bytes(selected.reduce((sum, entry) => sum + (entry.type === 'folder' ? 0 : entry.size), 0))}`;
  if (pane.search) text += ` · Search in ${pane.path}${pane.search.done ? '' : ' · Searching…'}`;
  if (busy) text += ' · Applying file operation…';
  $('#status-text').textContent = extra || text;
}

async function load(pane, { append = false, refresh = false, preserveSelection = false, loadedCapacity = null, destination = pane.path } = {}) {
  const savedSelection = preserveSelection ? new Set(pane.selection) : null;
  const loadedCount = preserveSelection ? loadedCapacity ?? pane.entries.length : 240;
  if (!append) {
    if (pane.search && !pane.search.done) await api.cancelSearch(pane.search.id).catch(() => {});
    pane.search = null;
    if (pane.listId) await api.cancelList(pane.listId).catch(() => {});
  }
  const version = ++pane.version;
  pane.loading = true; pane.listId = crypto.randomUUID();
  if (!append && !preserveSelection) pane.selection.clear();
  renderPane(pane); if (pane === activePane) updateToolbar();
  try {
    const result = destination === 'trash:' ? await api.trash() : await api.list({ path: destination, offset: append ? pane.nextOffset : 0, limit: 240, sort: pane.sort, direction: pane.direction, hidden, filter: pane.filter, requestId: pane.listId, refresh });
    while (preserveSelection && destination !== 'trash:' && result.nextOffset !== null && result.entries.length < loadedCount) {
      const page=await api.list({path:result.path,offset:result.nextOffset,limit:Math.min(1000,loadedCount-result.entries.length),sort:pane.sort,direction:pane.direction,hidden,filter:pane.filter});
      if(version!==pane.version)return;result.entries.push(...page.entries);result.nextOffset=page.nextOffset;
    }
    if (version !== pane.version) return;
    pane.path = result.path; pane.entries = append ? [...pane.entries, ...result.entries] : result.entries;
    if (savedSelection) pane.selection = new Set([...savedSelection].filter(file => pane.entries.some(entry => entry.path === file)));
    pane.total = result.total; pane.nextOffset = result.nextOffset ?? null; pane.warning = result.warning;
    pane.error = null;
    if (result.errors?.length) pane.warning = `${result.errors.length} Trash entries could not be read; remaining entries are shown.`;
  } catch (error) {
    if (version !== pane.version) return;
    if (error.code !== 'CANCELLED') { pane.error = error.message; toast(error.message, true); }
  } finally {
    if (version === pane.version) {
      pane.loading = false; pane.listId = null; renderPane(pane); renderTabs(); syncWatches();
      if (pane === activePane) { updateToolbar(); renderNavigation(); }
    }
  }
}

async function navigate(pane, file, fromHistory = false) {
  if (!pane || busy) return;
  pane.filter = ''; $('#search-input').value = '';
  await load(pane, { destination: file });
  if (pane.error || pane.path !== file && file === 'trash:') return;
  if (!fromHistory && pane.history[pane.historyIndex] !== pane.path) {
    pane.history = pane.history.slice(0, pane.historyIndex + 1); pane.history.push(pane.path); pane.historyIndex++;
  }
  if (pane === activePane) updateToolbar();
}
async function historyStep(step) {
  const pane = activePane, next = pane.historyIndex + step;
  if (next < 0 || next >= pane.history.length) return;
  pane.historyIndex = next; await navigate(pane, pane.history[next], true);
}

const thumbnailObserver = new IntersectionObserver(records => {
  for (const record of records) if (record.isIntersecting) {
    thumbnailObserver.unobserve(record.target);
    thumbnailQueue.push(record.target); pumpThumbnails();
  }
}, { rootMargin: '140px' });
function pumpThumbnails() {
  while (thumbnailRunning < 5 && thumbnailQueue.length) {
    const visual = thumbnailQueue.shift(); if (!visual.isConnected) continue;
    thumbnailRunning++;
    const cacheKey = `${visual.dataset.path}:${visual.dataset.identity}`;
    const cached = thumbnailCache.get(cacheKey);
    Promise.resolve(cached || api.preview(visual.dataset.path)).then(preview => {
      if (!preview.url || preview.type !== 'image') return;
      thumbnailCache.set(cacheKey, preview);
      while (thumbnailCache.size > 600) thumbnailCache.delete(thumbnailCache.keys().next().value);
      if (!visual.isConnected) return;
      const image = el('img'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
      image.onerror = () => { thumbnailCache.delete(cacheKey); image.remove(); };
      image.onload = () => { const graphic = visual.querySelector('svg'); if (graphic) graphic.remove(); };
      image.src = preview.url; visual.append(image);
    }).catch(() => {}).finally(() => { thumbnailRunning--; pumpThumbnails(); });
  }
}

function loadedCount(pane) {
  const count = el('span', 'folder-count');
  const loaded = pane.entries.length, total = pane.total;
  if (pane.search) {
    withIcon(count, 'search'); count.append(el('span', '', loaded.toLocaleString()));
    count.title = `${loaded.toLocaleString()} observed search matches; this count does not measure search completeness.`;
  } else {
    const fraction = total > 0 ? Math.min(1, loaded / total) : 0;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('loaded-ring'); svg.setAttribute('viewBox','0 0 28 28'); svg.setAttribute('aria-hidden','true');
    for (const className of ['ring-track','ring-progress']) {
      const circle = document.createElementNS('http://www.w3.org/2000/svg','circle');
      circle.setAttribute('cx','14'); circle.setAttribute('cy','14'); circle.setAttribute('r','10'); circle.setAttribute('pathLength','100'); circle.setAttribute('class',className);
      if (className === 'ring-progress') circle.setAttribute('stroke-dashoffset',String(100 - fraction * 100));
      svg.append(circle);
    }
    count.dataset.loaded = String(loaded); count.dataset.total = String(total);
    count.append(svg, el('span', '', `${loaded.toLocaleString()}/${total.toLocaleString()}`));
    count.title = `${loaded.toLocaleString()} of ${total.toLocaleString()} ${pane.filter ? 'matching ' : ''}folder entries loaded${total > 0 ? ` · ${Math.round(fraction * 100)}%` : ''}. This measures loaded entries, not storage usage.`;
  }
  count.setAttribute('role','img'); count.setAttribute('aria-label',count.title); return count;
}
function renderPane(pane) {
  if (pane !== secondary && pane.id !== selectedTab) return;
  const target = paneElement(pane);
  const previousScroll = target.querySelector('.file-scroll')?.scrollTop || 0;
  for (const visual of target.querySelectorAll('.file-visual[data-path]')) thumbnailObserver.unobserve(visual);
  target.classList.toggle('compact', density === 'compact'); target.classList.toggle('large', density === 'large');
  target.replaceChildren();
  const heading = el('div', 'pane-heading');
  const headingText = el('div', 'pane-heading-text');
  headingText.append(el('h1', '', pane.search ? 'Search results' : pane.path === 'trash:' ? 'Trash' : pane.path === boot.home ? 'Home' : basename(pane.path)));
  headingText.append(el('div', 'pane-path', pane.search ? `Within ${pane.path} · “${pane.search.query}”` : pane.path === 'trash:' ? 'Recover your files whenever you need them' : pane.path));
  heading.append(headingText, loadedCount(pane));
  const actions = el('div', 'pane-actions');
  if (pane.path === 'trash:') { const restore = graphicAction(el('button', 'tool-button'), 'Restore', 'undo', 'Restore selection'); restore.disabled = !pane.selection.size || busy; restore.onclick = () => restoreSelection(pane); actions.append(restore); }
  if (pane.search) { const clear = withIcon(el('button', 'icon-button'), 'close'); clear.title = 'Close search results'; clear.onclick = () => load(pane); actions.append(clear); }
  heading.append(actions); target.append(heading);
  if (pane.warning) target.append(el('div', 'warning-banner', pane.warning));
  if (pane.search) {
    const search = pane.search;
    const message = search.source === 'librarian' ? `${pane.entries.length} observed files · selected by VEYL` : `${search.done ? search.cancelled ? 'Cancelled' : search.limited ? 'Search limit reached; narrow the scope to find more' : 'Search complete' : 'Searching subfolders'} · ${(search.visited || 0).toLocaleString()} entries checked${search.skipped ? ` · ${search.skipped} inaccessible or skipped folders/files` : ''}`;
    target.append(el('div', 'search-summary', message));
  }
  const scroll = el('div', 'file-scroll');
  if (pane.loading && !pane.entries.length) {
    const loading = el('div', 'loading-state'); const ring = el('span', 'loading-ring'); loading.append(ring, el('span', '', 'Opening folder…')); scroll.append(loading);
  } else if (pane.error && !pane.entries.length) {
    const empty = withIcon(el('div', 'empty-state'), 'warning'); empty.append(el('h2', '', 'This folder could not be opened'), el('p', '', pane.error)); scroll.append(empty);
  } else if (!pane.entries.length) {
    const empty = withIcon(el('div', 'empty-state'), pane.search ? 'search' : pane.path === 'trash:' ? 'trash' : 'folder');
    empty.append(el('h2', '', pane.search ? pane.search.done ? 'No matches in this scope' : 'Looking through your files…' : pane.filter ? 'No matching names' : pane.path === 'trash:' ? 'A clean slate' : 'Room for something new'));
    empty.append(el('p', '', pane.search ? 'Search is bounded to this folder, without following shortcuts or other mounted filesystems.' : pane.path === 'trash:' ? 'Files you move to Trash will appear here for recovery.' : pane.filter ? 'Try a different phrase or search through subfolders.' : 'Create a folder or paste files to begin.'));
    scroll.append(empty);
  } else {
    if (view === 'list') {
      const header = el('div', 'list-header'); for (const title of ['Name', 'Size', 'Modified', 'Type']) header.append(el('span', '', title)); scroll.append(header);
    }
    const files = el('div', `files${view === 'list' ? ' detail-list' : ''}`); files.setAttribute('role', 'listbox'); files.setAttribute('aria-label', 'Files'); files.setAttribute('aria-multiselectable', 'true');
    pane.entries.forEach((entry, index) => {
      const card = el('div', `file-card${pane.selection.has(entry.path) ? ' selected' : ''}${clipboard?.action === 'move' && clipboard.paths.includes(entry.path) ? ' cut' : ''}`);
      card.dataset.path = entry.path; card.dataset.type = entry.type; card.tabIndex = pane.focused === entry.path || !pane.focused && index === 0 ? 0 : -1;
      card.setAttribute('role', 'option'); card.setAttribute('aria-selected', String(pane.selection.has(entry.path))); card.setAttribute('aria-label', `${entry.name}, ${typeLabel(entry)}`);
      card.title = `${entry.name}\n${typeLabel(entry)}${entry.type === 'folder' ? '' : ` · ${bytes(entry.size)}`}\n${fullDate(entry.modified)}${entry.originalPath ? `\nOriginal: ${entry.originalPath}` : ''}`;
      const check = withIcon(el('span', 'selection-dot'), 'check'); card.append(check);
      const visual = withIcon(el('div', 'file-visual'), entry.type === 'audio' ? 'music' : entry.type === 'text' ? 'file' : entry.type);
      typeIcons.decorate(visual,entry);
      if (entry.type === 'image') { visual.dataset.path = entry.path; visual.dataset.identity = entry.identity; thumbnailObserver.observe(visual); }
      card.append(visual, el('div', 'file-name', entry.name));
      const meta = entry.type === 'folder' ? 'Folder' : entry.type === 'symlink' ? 'Shortcut' : `${bytes(entry.size)} · ${entry.extension.toUpperCase() || 'FILE'}`;
      card.append(el('div', 'file-meta', meta));
      if (view === 'list') {
        card.append(el('div', 'list-cell', entry.type === 'folder' ? '—' : bytes(entry.size)), el('div', 'list-cell', date(entry.modified)), el('div', 'list-cell', entry.type === 'folder' ? 'Folder' : entry.extension.toUpperCase() || entry.type));
      }
      card.onclick = event => { event.stopPropagation(); setActive(pane); selectEntry(pane, index, event); };
      card.ondblclick = event => { event.stopPropagation(); openEntry(pane, entry); };
      card.oncontextmenu = event => {
        if(window.getSelection()?.toString())return;
        event.preventDefault(); event.stopPropagation(); setActive(pane);
        if (!pane.selection.has(entry.path)) selectEntry(pane, index, {});
        showContext(event.clientX, event.clientY, pane, entry);
      };
      card.onfocus = () => { pane.focused = entry.path; };
      card.draggable = pane.path !== 'trash:';
      card.ondragstart = event => {
        if (!pane.selection.has(entry.path)) selectEntry(pane, index, {});
        event.dataTransfer.setData('application/x-systemus-paths', JSON.stringify([...pane.selection]));
        event.dataTransfer.effectAllowed = 'copyMove';
      };
      if (entry.navigable && entry.type !== 'symlink' && pane.path !== 'trash:') {
        card.ondragover = event => { if ((event.dataTransfer.types.includes('application/x-systemus-paths') || event.dataTransfer.types.includes('Files'))) { event.preventDefault(); event.stopPropagation(); card.classList.add('drop-target'); event.dataTransfer.dropEffect = event.dataTransfer.types.includes('Files') ? 'copy' : event.ctrlKey ? 'copy' : 'move'; } };
        card.ondragleave = () => card.classList.remove('drop-target');
        card.ondrop = event => { event.preventDefault(); event.stopPropagation(); card.classList.remove('drop-target'); dropFiles(event, entry.path); };
      }
      files.append(card);
    });
    scroll.append(files);
    if (pane.nextOffset !== null) {
      const more = el('button', 'load-more', pane.loading ? 'Loading…' : `Load next 240 · ${(pane.total - pane.entries.length).toLocaleString()} remaining`);
      more.disabled = pane.loading; more.onclick = () => load(pane, { append: true }); scroll.append(more);
    }
  }
  scroll.onclick = event => { if (event.target === scroll || event.target.classList.contains('files')) { pane.selection.clear(); updateSelection(pane); } };
  scroll.oncontextmenu = event => { if(window.getSelection()?.toString()||event.target.closest('input,textarea,[contenteditable]'))return;if (!event.target.closest('.file-card')) { event.preventDefault(); setActive(pane); showContext(event.clientX, event.clientY, pane); } };
  target.append(scroll);
  scroll.scrollTop = previousScroll;
  const hint = el('div', 'pane-drop-hint', 'Desktop drop copies · Internal drop moves · Ctrl copies'); target.append(hint);
  target.onpointerdown = () => setActive(pane);
  target.ondragover = event => { if ((event.dataTransfer.types.includes('application/x-systemus-paths') || event.dataTransfer.types.includes('Files')) && pane.path !== 'trash:' && !pane.search) { event.preventDefault(); target.classList.add('drop-target'); event.dataTransfer.dropEffect = event.dataTransfer.types.includes('Files') ? 'copy' : event.ctrlKey ? 'copy' : 'move'; } };
  target.ondragleave = event => { if (!target.contains(event.relatedTarget)) target.classList.remove('drop-target'); };
  target.ondrop = event => { event.preventDefault(); target.classList.remove('drop-target'); if (pane.path !== 'trash:' && !pane.search) dropFiles(event, pane.path); };
}

function selectEntry(pane, index, event = {}) {
  const entry = pane.entries[index]; if (!entry) return;
  if (event.shiftKey && pane.anchor >= 0) {
    if (!event.ctrlKey && !event.metaKey) pane.selection.clear();
    const first = Math.min(pane.anchor, index), last = Math.max(pane.anchor, index);
    for (let n = first; n <= last; n++) pane.selection.add(pane.entries[n].path);
  } else if (event.ctrlKey || event.metaKey) {
    if (pane.selection.has(entry.path)) pane.selection.delete(entry.path); else pane.selection.add(entry.path);
    pane.anchor = index;
  } else { pane.selection = new Set([entry.path]); pane.anchor = index; }
  pane.focused = entry.path; updateSelection(pane);
}
function updateSelection(pane) {
  for (const card of paneElement(pane).querySelectorAll('.file-card')) {
    const selected = pane.selection.has(card.dataset.path); card.classList.toggle('selected', selected); card.setAttribute('aria-selected', String(selected)); card.tabIndex = pane.focused === card.dataset.path ? 0 : -1;
  }
  const restore = paneElement(pane).querySelector('.pane-actions .tool-button'); if (restore) restore.disabled = !pane.selection.size || busy;
  if (pane === activePane) updateToolbar();
  clearTimeout(inspectorTimer); inspectorTimer = setTimeout(() => showInspector(), 120);
  updateChatContext();
}

async function openEntry(pane, entry) {
  if (pane.path === 'trash:') { toggleInspector(true); return; }
  if (entry.navigable) return navigate(pane, entry.path);
  if (entry.type === 'symlink') return toast('This shortcut is not a folder. Inspect its target in Details.', true);
  return externalOpen(entry);
}
async function externalOpen(entry, reveal = false) {
  try {
    if (!reveal && (['desktop', 'sh', 'run', 'appimage', 'exe', 'bin'].includes(entry.extension) || entry.mode & 0o111)) {
      const confirmed = await dialog({ title: 'Open this executable?', description: `${entry.name}\nYour system may run this file. Continue only if you intend to launch it.`, confirm: 'Open', icon: 'external' });
      if (!confirmed) return;
    }
    await api.openExternal(entry.path, reveal);
  } catch (error) { toast(error.message, true); }
}

async function showInspector() {
  if ($('#inspector').hidden) return;
  const version = ++inspectorVersion, content = $('#inspector-content');
  const entries = currentEntries(); content.replaceChildren();
  if (entries.length !== 1) {
    const empty = withIcon(el('div', 'empty-state'), 'info'); empty.append(el('h2', '', entries.length ? `${entries.length} items selected` : 'A closer look'), el('p', '', entries.length ? `Combined file size: ${bytes(entries.reduce((sum, e) => sum + (e.type === 'folder' ? 0 : e.size), 0))}. Folder contents are not included.` : 'Select a file to preview it and see its properties.')); content.append(empty); return;
  }
  const selected = entries[0];
  const frame = withIcon(el('div', 'preview-frame'), selected.type === 'audio' ? 'music' : selected.type); typeIcons.decorate(frame,selected);
  content.append(frame, el('h2', '', selected.name));
  try {
    const [properties, preview] = await Promise.all([api.properties(selected.path), api.preview(selected.path)]);
    if (version !== inspectorVersion || $('#inspector').hidden) return;
    const list = el('dl');
    const rows = [['Kind', typeLabel(properties)], ['Size', properties.type === 'folder' ? 'Folder contents not calculated' : bytes(properties.size)], ['Modified', fullDate(properties.modified)], ['Created', fullDate(properties.created)], ['Location', selected.originalPath || properties.path], ['Permissions', properties.mode.toString(8).padStart(4, '0')], ['Owner', `UID ${properties.uid} · GID ${properties.gid}`]];
    if (properties.target) rows.push(['Link target', properties.target]);
    if (properties.filesystem) rows.push(['Available', `${bytes(properties.filesystem.available)} of ${bytes(properties.filesystem.total)}`]);
    if (selected.deleted) rows.push(['Trashed', selected.deleted]);
    for (const [label, value] of rows) { const row = el('div', 'property-row'); row.append(el('dt', '', label), el('dd', '', value)); list.append(row); }
    content.append(list);
    if (preview.type === 'text') { const text = el('pre', 'preview-text', `${preview.text}${preview.truncated ? '\n\n[Preview limited to 256 KiB]' : ''}`); frame.replaceChildren(text); }
    else if (preview.url) {
      if (preview.type === 'image') { const image = el('img'); image.src = preview.url; image.alt = selected.name; frame.replaceChildren(image); }
      else if (preview.type === 'video' || preview.type === 'audio') { const media = el(preview.type); media.controls = true; media.preload = 'metadata'; media.src = preview.url; frame.replaceChildren(media); }
      else if (preview.type === 'pdf') { const pdf = el('iframe'); pdf.src = preview.url; pdf.title = `Preview of ${selected.name}`; pdf.setAttribute('sandbox', ''); frame.replaceChildren(pdf); }
    }
    const actions = el('div', 'inspector-actions');
    if (activePane.path === 'trash:') { const restore = withIcon(el('button', 'secondary-button', 'Restore'), 'undo'); restore.onclick = () => restoreSelection(activePane); actions.append(restore); }
    else {
      const open = withIcon(el('button', 'secondary-button', 'Open'), 'external'); open.onclick = () => externalOpen(selected);
      const reveal = withIcon(el('button', 'secondary-button', 'Reveal'), 'folder'); reveal.onclick = () => externalOpen(selected, true);
      actions.append(open, reveal);
    }
    content.append(actions);
  } catch (error) { if (version === inspectorVersion) content.append(el('p', 'dialog-error', error.message)); }
}
function toggleInspector(force) {
  const show = force ?? $('#inspector').hidden; $('#inspector').hidden = !show; $('#inspector-toggle').classList.toggle('active', show);
  if (show) { $('#librarian').hidden = true; showInspector(); }
  else inspectorVersion++;
}

function dialog({ title, description = '', confirm = 'Continue', icon: type = 'folder', danger = false, fields = [], preview = null }) {
  if (dialogResolver) return Promise.resolve(null);
  $('#dialog-title').textContent = title; $('#dialog-description').textContent = description;
  $('#dialog-icon').innerHTML = icon(type);
  $('#dialog-confirm').textContent = confirm; $('#dialog-confirm').classList.toggle('danger', danger);
  $('#dialog-error').textContent = ''; $('#dialog-fields').replaceChildren();
  const inputs = {};
  for (const field of fields) {
    const label = el('label', `dialog-field${field.type === 'checkbox' ? ' checkbox' : ''}`);
    const input = el('input'); input.name = field.name; input.type = field.type || 'text';
    if (field.type === 'checkbox') { input.checked = Boolean(field.value); label.append(input, el('span', '', field.label)); }
    else { input.value = field.value || ''; input.required = field.required !== false; input.autocomplete = 'off'; input.spellcheck = false; label.append(el('span', '', field.label), input); }
    inputs[field.name] = input; $('#dialog-fields').append(label);
  }
  const values = () => Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.type === 'checkbox' ? input.checked : input.value]));
  if (preview) {
    const output = el('div', 'batch-preview'); const update = () => { output.textContent = preview(values()); };
    for (const input of Object.values(inputs)) input.addEventListener('input', update); update(); $('#dialog-fields').append(output);
  }
  $('#action-dialog').showModal();
  setTimeout(() => { const first = Object.values(inputs)[0]; if (first) { first.focus(); if (first.type === 'text') first.select(); } else $('#dialog-cancel').focus(); }, 0);
  return new Promise(resolve => {
    dialogResolver = result => { dialogResolver = null; $('#action-dialog').close(); resolve(result); };
    $('#dialog-form').onsubmit = event => { event.preventDefault(); dialogResolver?.(values()); };
  });
}
$('#dialog-cancel').onclick = () => dialogResolver?.(null);
$('#action-dialog').addEventListener('cancel', event => { event.preventDefault(); dialogResolver?.(null); });

async function perform(request, execute = () => api.mutate(request)) {
  if (busy) { toast('Wait for the current file operation to finish.'); return null; }
  busy = true; updateToolbar();
  try {
    const result = await execute();
    $('#undo').dataset.available = result.undoAvailable ? 'yes' : '';
    if(result.warning)toast(result.warning,true,true);
    const count = result.changes.length;
    if (result.errors.length) {
      toast(`${count} completed · ${result.errors.length} could not complete. Original files were not overwritten.`, true, true);
      const details = result.errors.map(error => `${basename(error.path || '')}: ${error.message}${error.partial?.destination ? `\nPartial copy: ${error.partial.destination}\n${error.partial.message || ''}` : ''}`).join('\n\n');
      await dialog({ title: count ? 'Some changes need attention' : 'No changes completed', description: details, confirm: 'Close', icon: 'warning' });
    } else if (count) toast(`${request.action === 'trash' ? 'Moved to Trash' : request.action === 'restore' ? 'Restored' : request.action === 'undo' ? 'Undid operation' : 'Completed'} · ${count} ${count === 1 ? 'item' : 'items'}`);
    await refreshAll(result.changes); return result;
  } catch (error) { toast(error.message, true); return null; }
  finally { busy = false; updateToolbar(); }
}
async function refreshAll(changes = []) {
  const visible = [tabs.find(tab => tab.id === selectedTab), ...(dual ? [secondary] : [])].filter(Boolean);
  await Promise.all(visible.map(pane => pane.search ? Promise.resolve() : load(pane, {
    refresh: true, preserveSelection: true,
    // Retain the user's loaded window, rounded to its next page, rather than loading the full folder.
    loadedCapacity: Math.max(240, Math.ceil(pane.entries.length / 240) * 240)
  })));
  for (const pane of visible) {
    const targets = changes.map(change => change.destination).filter(file => pane.entries.some(entry => entry.path === file));
    if (targets.length) { pane.selection = new Set(targets); pane.focused = targets[0]; renderPane(pane); }
  }
  updateToolbar();
  showInspector();
}
async function createEntry(folder = false, pane = activePane) {
  if (pane.path === 'trash:' || pane.search) return;
  const result = await dialog({ title: folder ? 'A new folder' : 'A new file', description: `Create in ${pane.path}`, confirm: 'Create', icon: folder ? 'folder' : 'file', fields: [{ name: 'name', label: 'Name', value: folder ? 'Untitled folder' : 'Untitled.txt' }] });
  if (result) await perform({ action: folder ? 'new-folder' : 'new-file', destination: pane.path, name: result.name });
}
async function renameSelection(pane = activePane) {
  const entries = currentEntries(pane); if (!entries.length || pane.path === 'trash:') return;
  if (entries.length === 1) {
    const result = await dialog({ title: 'Rename file or folder', description: 'The existing name is preserved if the new name is occupied.', confirm: 'Rename', icon: 'rename', fields: [{ name: 'name', label: 'New name', value: entries[0].name }] });
    if (result) await perform({ action: 'rename', path: entries[0].path, name: result.name });
  } else {
    const result = await dialog({ title: `Rename ${entries.length} items`, description: 'Each name becomes a prefix plus a three-digit number. Review the preview before applying. Existing destination names are never overwritten.', confirm: 'Apply names', icon: 'rename', fields: [{ name: 'prefix', label: 'Prefix', value: 'File-' }, { name: 'start', label: 'Starting number', value: '1', type: 'number' }, { name: 'keepExtension', label: 'Keep file extensions', value: true, type: 'checkbox' }], preview: values => entries.slice(0, 12).map((entry, index) => `${entry.name} → ${values.prefix}${String(Math.max(0, Number.isFinite(Number(values.start)) ? Number(values.start) : 1) + index).padStart(3, '0')}${values.keepExtension && entry.type !== 'folder' && entry.extension ? `.${entry.extension}` : ''}`).join('\n') });
    if (result) await perform({ action: 'batch-rename', paths: entries.map(e => e.path), ...result });
  }
}
async function copySelection(cut = false, pane = activePane) {
  const entries = currentEntries(pane); if (!entries.length || pane.path === 'trash:') return;
  try { clipboard = await api.copyFiles(entries.map(entry => entry.path), cut); renderPane(pane); updateToolbar(); toast(`${entries.length} ${cut ? 'cut' : 'copied'} to system clipboard`); }
  catch(error) { toast(error.message,true); }
}
async function pasteSelection(pane = activePane) {
  if (pane.path === 'trash:' || pane.search) return;
  await perform({action:'paste'},()=>api.pasteFiles(pane.path));
  clipboard = await api.clipboardFiles().catch(()=>null);updateToolbar();
}
async function archiveSelection(extract=false,format='zip',pane=activePane) {
  const entries=currentEntries(pane);if(!entries.length||pane.path==='trash:')return;
  if(extract&&entries.length!==1)return toast('Choose one archive to extract.',true);
  const proposed=extract?entries[0].name.replace(/\.(?:tar\.gz|tgz|zip|tar)$/i,'')+'-extracted':(entries.length===1?entries[0].name:'Archive')+'.'+format;
  const values=await dialog({title:extract?'Extract into a new folder':`Create ${format.toUpperCase()} archive`,description:extract?'Creates an exclusive new folder. Unsafe archive entries are refused before extraction; existing folders are never merged.':'Selected ordinary files/folders are archived without changing originals. Links and special files are excluded. Limits: 100,000 entries, 20 GiB, 120 seconds.',confirm:extract?'Extract':'Create archive',fields:[{name:'name',label:extract?'New folder name':'Archive filename',value:proposed}]});
  if(values)await perform({action:extract?'archive-extract':'archive-create',paths:entries.map(e=>e.path),destination:pane.path,name:values.name,format});
}
async function trashSelection(pane = activePane) {
  const entries = currentEntries(pane); if (!entries.length || pane.path === 'trash:') return;
  try {
    const confirmation = await api.prepareTrash(entries.map(entry => entry.path));
    const result = await dialog({ title: `Move ${entries.length === 1 ? 'this item' : `${entries.length} items`} to Trash?`, description: `${entries.slice(0, 8).map(entry => entry.name).join('\n')}${entries.length > 8 ? `\n… and ${entries.length - 8} more` : ''}\n\nYou can restore these files from Trash. Nothing is permanently deleted.`, confirm: 'Move to Trash', icon: 'trash', danger: true });
    if (result) await perform({ action: 'trash', token: confirmation.token, confirmed: true });
  } catch (error) { toast(error.message, true); }
}
async function restoreSelection(pane) {
  const entries = currentEntries(pane); if (!entries.length) return;
  await perform({ action: 'restore', items: entries.map(entry => ({ trashId: entry.trashId, trashRoot: entry.trashRoot })) });
}
async function dropFiles(event, destination) {
  try {
    const internal=event.dataTransfer.getData('application/x-systemus-paths');
    const paths=internal?JSON.parse(internal):api.droppedPaths(Array.from(event.dataTransfer.files));
    if(!Array.isArray(paths)||!paths.length||paths.length>500||paths.some(file=>!file))throw new Error('Drop 1–500 local files from the desktop.');
    let action=internal?(event.ctrlKey?'copy':'move'):'copy';
    if(!internal&&event.shiftKey){const approved=await dialog({title:'Move dropped files?',description:`Move these ${paths.length} files into ${destination}?\n${paths.slice(0,12).join('\n')}\n\nSources will be removed only after a verified transfer. Existing files are never overwritten.`,confirm:'Move files',icon:'warning'});if(!approved)return;action='move';}
    await perform({action,paths,destination});
  } catch (error) { toast(error.message, true); }
}

function showContext(x, y, pane, entry) {
  const menu = $('#context-menu'); menu.replaceChildren();
  const add = (label, type, action, shortcut = '', danger = false, disabled = false) => {
    const compact = label.replace(/^Create (ZIP|TAR|TAR\.GZ) archive…$/, '$1').replace(/^Open with default app$/, 'Open').replace(/^Move to Trash…$/, 'Trash').replace(/^Extract into new folder…$/, 'Extract').replace(/^Open in new tab$/, 'New tab').replace(/^Restore selection$/, 'Restore').replace(/^Properties$/, 'Details');
    const button = withIcon(el('button', `menu-item${danger ? ' danger' : ''}`), type); button.append(el('span', 'menu-caption', compact)); button.setAttribute('role', 'menuitem'); button.setAttribute('aria-label', label); button.title = `${label}${shortcut ? ` (${shortcut})` : ''}`; button.disabled = disabled;
    if (shortcut) button.append(el('span', 'menu-shortcut sr-only', shortcut)); button.onclick = () => { hideContext(); action(); }; menu.append(button);
  };
  const separator = () => menu.append(el('div', 'menu-separator'));
  if (pane.path === 'trash:') { add('Restore selection', 'undo', () => restoreSelection(pane), '', false, !pane.selection.size); add('Properties', 'info', () => toggleInspector(true)); }
  else if (entry) {
    add(entry.navigable ? 'Open folder' : 'Open with default app', 'external', () => openEntry(pane, entry), 'Enter');
    if (entry.navigable) add('Open in new tab', 'plus', () => addTab(entry.path));
    separator();
    add('Copy', 'copy', () => copySelection(false, pane), 'Ctrl+C'); add('Cut', 'cut', () => copySelection(true, pane), 'Ctrl+X');
    add(pane.selection.size > 1 ? 'Batch rename…' : 'Rename…', 'rename', () => renameSelection(pane), 'F2');
    add('Duplicate', 'copy', () => perform({ action: 'duplicate', paths: [...pane.selection] }));
    separator();
    for(const format of ['zip','tar','tar.gz'])add(`Create ${format.toUpperCase()} archive…`,'file',()=>archiveSelection(false,format,pane));
    if(pane.selection.size===1&&/\.(zip|tar|tar\.gz|tgz)$/i.test(entry.name))add('Extract into new folder…','folder',()=>archiveSelection(true,'zip',pane));
    separator(); add('Move to Trash…', 'trash', () => trashSelection(pane), 'Delete', true); add('Properties', 'info', () => toggleInspector(true), 'Alt+Enter');
  } else {
    add('New folder…', 'folder', () => createEntry(true, pane), 'Ctrl+Shift+N', false, Boolean(pane.search));
    add('New file…', 'file', () => createEntry(false, pane), '', false, Boolean(pane.search));
    add('Paste here', 'paste', () => pasteSelection(pane), 'Ctrl+V', false, Boolean(pane.search));
    separator(); add('Refresh', 'refresh', () => load(pane, { refresh: true }), 'F5'); add(hidden ? 'Hide hidden files' : 'Show hidden files', 'eye', toggleHidden, 'Ctrl+H');
    add('Bookmark folder', 'star', bookmarkCurrent, '', false, Boolean(pane.search));
  }
  menu.hidden = false;
  menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 8)}px`; menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.querySelector('button:not(:disabled)')?.focus();
}
function hideContext() { $('#context-menu').hidden = true; }
document.addEventListener('pointerdown', event => { if (!event.target.closest('#context-menu')) hideContext(); });
window.addEventListener('blur', hideContext);

function bookmarkCurrent() {
  const pane = activePane; if (pane.path === 'trash:') return;
  if (bookmarks.some(bookmark => bookmark.path === pane.path)) return toast('This folder is already bookmarked.');
  bookmarks.push({ path: pane.path, label: pane.path === boot.home ? 'Home' : basename(pane.path) }); renderNavigation(); savePreferences(); toast('Added to your bookmarks');
}
function toggleHidden() { hidden = !hidden; $('#hidden-toggle').setAttribute('aria-pressed', String(hidden)); refreshAll(); savePreferences(); }
function setView(next) {
  view = next; $('#view-grid').classList.toggle('active', view === 'grid'); $('#view-list').classList.toggle('active', view === 'list');
  $('#view-grid').setAttribute('aria-pressed', String(view === 'grid')); $('#view-list').setAttribute('aria-pressed', String(view === 'list'));
  renderPane(tabs.find(tab => tab.id === selectedTab)); if (dual) renderPane(secondary); savePreferences();
}
function toggleDual() {
  dual = !dual; $('#pane-secondary').hidden = !dual; $('#panes').classList.toggle('dual', dual); $('#dual-toggle').classList.toggle('active', dual);
  if (dual) { if (!secondary) secondary = newPane(activePane.path === 'trash:' ? boot.home : activePane.path); load(secondary); }
  else { if (secondary?.search && !secondary.search.done) api.cancelSearch(secondary.search.id).catch(() => {}); setActive(tabs.find(tab => tab.id === selectedTab)); }
  savePreferences(); syncWatches();
}
function editPath() {
  if (activePane.path === 'trash:') return;
  $('#breadcrumbs').hidden = true; $('#path-input').hidden = false; $('#path-input').value = activePane.path; $('#path-input').focus(); $('#path-input').select();
}
function closePath() { $('#path-input').hidden = true; $('#breadcrumbs').hidden = false; }
$('#path-input').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); const value = event.target.value; closePath(); navigate(activePane, value.startsWith('~/') ? `${boot.home}/${value.slice(2)}` : value === '~' ? boot.home : value); } else if (event.key === 'Escape') closePath(); };
$('#path-input').onblur = closePath;

async function startSearch(pane, query) {
  if (!query.trim() || pane.path === 'trash:') return;
  if (pane.listId) api.cancelList(pane.listId).catch(() => {});
  if (pane.search && !pane.search.done) await api.cancelSearch(pane.search.id).catch(() => {});
  pane.version++; pane.loading = false; pane.filter = ''; pane.entries = []; pane.selection.clear(); pane.total = 0; pane.nextOffset = null; pane.warning = null;
  pane.search = { id: null, query, visited: 0, found: 0, done: false, pending: true };
  renderPane(pane); updateToolbar();
  try { const { id } = await api.search({ path: pane.path, query, hidden }); if (pane.search?.pending) { pane.search.id = id; pane.search.pending = false; } }
  catch (error) { pane.search.done = true; pane.error = error.message; renderPane(pane); updateToolbar(); toast(error.message, true); }
}
api.onSearch(update => {
  const pane = [...paneMap.values()].find(item => item.search?.id === update.id || item.search?.pending && update.started && item.path === update.scope);
  if (!pane) return;
  pane.search.id = update.id; pane.search.pending = false;
  Object.assign(pane.search, { visited: update.visited, found: update.found, skipped: update.skipped });
  if (update.entries.length) { pane.entries.push(...update.entries); pane.total = pane.entries.length; }
  if (update.done) { pane.search.done = true; pane.search.cancelled = update.cancelled; pane.search.limited = update.limited; if (update.error) toast(update.error.message, true); }
  // Coalesce event rendering instead of repainting every result batch.
  if (!pane.renderPending) {
    pane.renderPending = true;
    setTimeout(() => { pane.renderPending = false; renderPane(pane); if (pane === activePane) updateToolbar(); }, 100);
  }
});
api.onListProgress(update => {
  const pane = [...paneMap.values()].find(item => item.listId === update.id);
  if (pane === activePane) updateStatus(`${update.stage === 'metadata' ? 'Reading metadata for full-folder sort' : update.stage === 'sorting' ? 'Sorting folder' : 'Reading folder'} · ${update.scanned.toLocaleString()}${update.total ? ` / ${update.total.toLocaleString()}` : ''} · Escape to cancel`);
});
api.onOperationProgress(update => { if (busy) updateStatus(`${update.stage || 'Working'} · ${(update.entries || 0).toLocaleString()} entries${update.source ? ' · '+basename(update.source) : ''}`); });

$('#back').onclick = () => historyStep(-1); $('#forward').onclick = () => historyStep(1); $('#up').onclick = () => navigate(activePane, parent(activePane.path));
$('#refresh').onclick = () => load(activePane, { refresh: true }); $('#edit-path').onclick = editPath;
$('#new-tab').onclick = () => addTab(); $('#new-folder').onclick = () => createEntry(true); $('#paste').onclick = () => pasteSelection();
$('#undo').onclick = () => perform({ action: 'undo' }); $('#rename').onclick = () => renameSelection(); $('#delete').onclick = () => trashSelection();
$('#hidden-toggle').onclick = toggleHidden; $('#bookmark-current').onclick = bookmarkCurrent; $('#trash-place').onclick = () => navigate(activePane, 'trash:');
$('.brand').onclick = event => { event.preventDefault(); navigate(activePane, boot.home); };
$('#view-grid').onclick = () => setView('grid'); $('#view-list').onclick = () => setView('list');
$('#density').onchange = event => { density = event.target.value; renderPane(tabs.find(tab => tab.id === selectedTab)); if (dual) renderPane(secondary); savePreferences(); };
$('#sort').onchange = event => { activePane.sort = event.target.value; load(activePane); };
$('#sort-direction').onclick = () => { activePane.direction = activePane.direction === 'asc' ? 'desc' : 'asc'; load(activePane); };
$('#dual-toggle').onclick = toggleDual;
$('#inspector-toggle').onclick = () => toggleInspector(); $('#close-inspector').onclick = () => toggleInspector(false);
$('#chat-toggle').onclick = () => { $('#librarian').hidden = !$('#librarian').hidden; if (!$('#librarian').hidden) toggleInspector(false); };
$('#close-chat').onclick = () => { $('#librarian').hidden = true; };
for (const suggestion of $$('.suggestion')) suggestion.onclick = () => { $('#chat-input').value = suggestion.dataset.prompt; $('#chat-input').focus(); };
$('#more-actions').onclick = event => { const bounds = event.currentTarget.getBoundingClientRect(); showContext(bounds.left, bounds.bottom + 6, activePane); };
graphicAction($('#search-mode'),'This folder','folder','Search this folder; toggle to include subfolders');
$('#search-mode').setAttribute('aria-pressed','false');
$('#search-mode').onclick = () => { recursive = !recursive; graphicAction($('#search-mode'),recursive ? 'Subfolders' : 'This folder',recursive ? 'split' : 'folder',recursive ? 'Search subfolders; toggle to this folder only' : 'Search this folder; toggle to include subfolders'); $('#search-mode').setAttribute('aria-pressed',String(recursive)); $('#search-mode').classList.toggle('recursive', recursive); $('#search-input').placeholder = recursive ? 'Search all subfolders…' : 'Find in this folder…'; };
let filterTimer;
$('#search-input').oninput = event => {
  if (recursive) return;
  clearTimeout(filterTimer); const query = event.target.value; const pane = activePane;
  filterTimer = setTimeout(() => { pane.filter = query; load(pane); }, 200);
};
$('#search-form').onsubmit = event => { event.preventDefault(); clearTimeout(filterTimer); const query = $('#search-input').value; if (recursive) startSearch(activePane, query); else { activePane.filter = query; load(activePane); } };
$('#cancel-search').onclick = () => { if (activePane.listId) api.cancelList(activePane.listId).catch(() => {}); if (activePane.search && !activePane.search.done) api.cancelSearch(activePane.search.id).catch(() => {}); };

document.addEventListener('keydown', event => {
  if (event.defaultPrevented) return;
  if ($('#action-dialog').open || $('#settings-dialog').open) return;
  if (event.key === 'Escape') {
    hideContext();
    if (activePane?.listId) api.cancelList(activePane.listId).catch(() => {});
    if (activePane?.search && !activePane.search.done) api.cancelSearch(activePane.search.id).catch(() => {});
  }
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
  // Native controls own their activation/navigation keys. File-card options and
  // the file-pane itself still use the explorer shortcuts below.
  if (!event.ctrlKey && !event.metaKey && !event.altKey && target?.closest('button,summary,a[href],[role="button"],[role="tab"],[role="menuitem"]')) return;
  const pane = activePane; if (!pane) return;
  const control = event.ctrlKey || event.metaKey;
  if(control&&window.getSelection()?.toString()&&['c','x','a'].includes(event.key.toLowerCase()))return;
  if (control) {
    const action = {
      l: editPath, t: () => addTab(), w: () => closeTab(selectedTab), f: () => { $('#search-input').focus(); $('#search-input').select(); },
      a: () => { pane.selection = new Set(pane.entries.map(entry => entry.path)); updateSelection(pane); },
      c: () => copySelection(), x: () => copySelection(true), v: () => pasteSelection(), z: () => perform({ action: 'undo' }), h: toggleHidden,
      n: () => { if (event.shiftKey) createEntry(true); }
    }[event.key.toLowerCase()];
    if (action) { event.preventDefault(); action(); return; }
  }
  if (event.altKey) {
    const action = { ArrowLeft: () => historyStep(-1), ArrowRight: () => historyStep(1), ArrowUp: () => navigate(pane, parent(pane.path)), Enter: () => toggleInspector(true) }[event.key];
    if (action) { event.preventDefault(); action(); return; }
  }
  if (event.key === 'F5') { event.preventDefault(); load(pane, { refresh: true }); }
  else if (event.key === 'F6') { event.preventDefault(); if (!dual) toggleDual(); else { setActive(pane === secondary ? tabs.find(tab => tab.id === selectedTab) : secondary); paneElement(activePane).focus(); } }
  else if (event.key === 'F2') { event.preventDefault(); renameSelection(); }
  else if (event.key === 'Delete') { event.preventDefault(); trashSelection(); }
  else if (event.key === 'Enter') { const entry = pane.entries.find(item => item.path === pane.focused) || currentEntries(pane)[0]; if (entry) { event.preventDefault(); openEntry(pane, entry); } }
  else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(event.key) && pane.entries.length) {
    event.preventDefault();
    let index = Math.max(0, pane.entries.findIndex(entry => entry.path === pane.focused));
    const first = paneElement(pane).querySelector('.file-card'); const width = paneElement(pane).querySelector('.files')?.clientWidth || 500;
    const columns = view === 'list' ? 1 : Math.max(1, Math.floor(width / ((first?.offsetWidth || 140) + 12)));
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = pane.entries.length - 1;
    else if (event.key === 'ArrowLeft') index--;
    else if (event.key === 'ArrowRight') index++;
    else if (event.key === 'ArrowUp') index -= columns;
    else if (event.key === 'ArrowDown') index += columns;
    index = Math.min(pane.entries.length - 1, Math.max(0, index));
    if (!control || event.key === ' ') selectEntry(pane, index, event.key === ' ' ? { ctrlKey: true } : event);
    else { pane.focused = pane.entries[index].path; updateSelection(pane); }
    const card = [...paneElement(pane).querySelectorAll('.file-card')].find(node => node.dataset.path === pane.entries[index].path); card?.focus(); card?.scrollIntoView({ block: 'nearest' });
  }
});

async function initialize() {
  try {
    await initializeSettings(api,async settings=>{retireChatPlan(chatPlan,'Settings changed · ask again');chatPlan=null;const state=await api.librarian.boot();chatAvailable=state.status.available;$('.librarian-header small').textContent=`${state.status.model} · ${state.status.reasoning||'configured'}`;chatStatus(state.status.message,state.status.available?'ready':'error');chatBusy(Boolean(chatJob));if(settings.warning)toast(settings.warning,true);});
    await typeIcons.initialize().catch(() => {});
    boot = await api.boot(); bookmarks = boot.bookmarks || [];
    view = boot.preferences.view || 'grid'; density = boot.preferences.density || 'comfortable'; hidden = Boolean(boot.preferences.hidden);
    $('#hidden-toggle').setAttribute('aria-pressed', String(hidden)); $('#density').value = density;
    const pane = newPane(boot.home); tabs.push(pane); selectedTab = pane.id; activePane = pane;
    renderNavigation(); renderTabs(); setView(view); await load(pane);
    if (boot.preferences.dualPane) toggleDual();
    if (boot.warning) toast(boot.warning, true);
    await initializeVEYL();
  } catch (error) { toast(`Workspace could not start: ${error.message}`, true, true); $('#status-text').textContent = 'Workspace connection failed.'; }
}
initialize();

function chatContext() {
  const pane = activePane;
  return { path: pane.path, selection: [...pane.selection], entries: pane.entries.slice(0, 240).map(entry => ({ path: entry.path, identity: entry.identity })), total: pane.total, revision: pane.version, sort: pane.sort, direction: pane.direction, view, hidden };
}
function sameChatContext(snapshot) {
  if (!snapshot || !activePane) return false;
  const current = chatContext();
  return JSON.stringify({ ...snapshot, contentPaths: undefined }) === JSON.stringify(current);
}
function updateChatContext() {
  if (!$('#chat-scope')) return;
  const label = chatScope || (activePane?.path === 'trash:' ? 'Choose a folder' : activePane?.path || 'Workspace');
  $('#chat-scope-label').textContent = label; $('#chat-scope-label').title = label;
  $('#chat-content-toggle').disabled = !activePane?.selection.size || Boolean(chatJob);
  $('#chat-content-note').textContent = activePane?.selection.size ? String(activePane.selection.size) : '—'; $('#chat-content-note').title = activePane?.selection.size ? `${activePane.selection.size} selected files` : 'Select a file first to permit its text';
  if (chatPlan && !sameChatContext(chatSnapshot)) {
    const button = $('#chat-messages .review-plan-button');
    if (button) { button.disabled = true; button.textContent = 'Context changed · ask again'; }
  }
}
function addChatMessage(role, text, extra = null) {
  const node = el('div', `chat-message ${role === 'user' ? 'user-message' : role === 'error' ? 'error-message' : role === 'result' ? 'result-message' : ''}`);
  const avatar = withIcon(el('span', 'message-avatar'), role === 'user' ? 'file' : role === 'error' ? 'warning' : role === 'result' ? 'check' : 'sparkle');
  const body = el('div', 'message-body'); body.append(el('strong', '', role === 'user' ? 'You' : role === 'error' ? 'VEYL · attention needed' : role === 'result' ? 'Local result' : 'VEYL'), el('p', '', text));
  if (extra) body.append(extra); node.append(avatar, body); $('#chat-messages').append(node);
  $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight; return node;
}
function chatStatus(text, state = 'ready') {
  const status = $('.agent-status span:nth-child(2)'); status.textContent = state === 'working' ? 'Working' : state === 'error' ? 'Attention' : 'Ready'; status.title = text; status.setAttribute('aria-label',text);
  $('.agent-status').dataset.state = state;
  const dot=$('.status-dot');dot.replaceChildren();if(state==='working')withIcon(dot,'hourglass');
  const tag = $('.status-tag'); tag.replaceChildren(); withIcon(tag,state === 'working' ? 'refresh' : state === 'error' ? 'warning' : 'terminal'); tag.title = text;
}
function chatBusy(value) {
  $('#chat-send').disabled = value || !chatAvailable;
  $('#chat-stop').hidden = !value;
  $('#chat-clear').disabled = value;
  $('#chat-scope').disabled = value;
  $('#chat-input').disabled = value;
  updateChatContext();
}
function retireChatPlan(plan, message) {
  if (!plan) return;
  for (const button of $$('#chat-messages .review-plan-button')) if (button.dataset.planToken === plan.token) { button.disabled = true; button.textContent = message; }
  for (const label of $$('#chat-messages .plan-not-applied')) if (label.dataset.planToken === plan.token) label.textContent = message;
}
async function initializeVEYL() {
  $('.sidebar-bottom small').textContent = 'File actions run locally';
  const sharing = el('details', 'sharing-details'); const summary = withIcon(el('summary', '', 'Sharing & controls'), 'info');
  sharing.append(summary, el('p', '', 'Requests and provided file context go through the file assistant’s selected provider in Settings. Explicit image-view or content-based naming requests share bounded image pixels for that turn automatically when supported; safe selected text still needs its separate permission. New file-type identifiers go through the type designer’s selected provider, without file paths or contents. Explicit commands run locally. Ask for a preview to review first. Stop and supported Undo remain available. API providers use your own selected key and may incur vendor charges.'));
  $('.chat-footnote').replaceChildren(sharing);
  $('.composer-footer span:nth-child(2)').textContent = 'Direct commands · Stop / Undo available'; $('.composer-footer span:nth-child(2)').classList.add('sr-only'); $('.composer-footer').title = 'Explicit commands run directly. Ask for a preview first if wanted. Stop / Undo available.';
  const clear = withIcon(el('button', 'icon-button small'), 'trash'); clear.id = 'chat-clear'; clear.title = 'Clear local chat history'; clear.setAttribute('aria-label', 'Clear local chat history');
  $('.librarian-header').insertBefore(clear, $('#close-chat'));
  clear.onclick = async () => {
    const confirmation = await dialog({ title: 'Clear this chat?', description: 'This removes VEYL’s local chat transcript. Your files and selected provider’s remote data handling are unaffected.', confirm: 'Clear local chat', icon: 'trash' });
    if (!confirmation) return;
    try { await api.librarian.clear(); $('#chat-messages').replaceChildren(); chatPlan = null; addChatMessage('assistant', 'A fresh conversation. Your files are unchanged.'); } catch (error) { toast(error.message, true); }
  };
  const scope = withIcon(el('button', 'chat-scope'), 'folder'); scope.id = 'chat-scope';
  scope.setAttribute('aria-label','Choose additional VEYL scope'); scope.title = 'Choose additional VEYL scope'; scope.append(el('span', 'chat-scope-label')); scope.lastChild.id = 'chat-scope-label';
  const scopeReset = graphicAction(el('button', 'scope-reset'), 'Visible folder','undo','Reset VEYL scope to visible folder');
  const scopeRow = el('div', 'chat-scope-row'); scopeRow.append(scope, scopeReset); $('.chat-composer').prepend(scopeRow);
  scope.onclick = async () => {
    const result = await dialog({ title: 'Choose VEYL scope', description: 'Grant one existing folder for this conversation. VEYL can observe it and propose changes inside it. Files outside the visible folder or this granted scope stay inaccessible.', confirm: 'Use scope', icon: 'folder', fields: [{ name: 'path', label: 'Existing folder path', value: chatScope || activePane.path }] });
    if (!result) return;
    try { const value = await api.librarian.setScope(result.path); chatScope = value.scope; chatPlan = null; updateChatContext(); addChatMessage('result', `VEYL scope now includes ${chatScope}.`); } catch (error) { toast(error.message, true); }
  };
  scopeReset.onclick = async () => { try { await api.librarian.setScope(null); chatScope = null; chatPlan = null; updateChatContext(); } catch (error) { toast(error.message, true); } };
  const permission = el('label', 'content-permission'); const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.id = 'chat-content-toggle';
  const permissionNote = el('span', 'content-permission-note'); permissionNote.id = 'chat-content-note';
  const permissionIcon = withIcon(el('span'), 'file'); permission.append(checkbox, permissionIcon, el('span', '', 'Include text'), permissionNote); permission.title = 'Permit safe selected text contents in this one request. Secrets/keyfiles remain excluded.'; checkbox.setAttribute('aria-label','Include selected text'); $('.chat-composer').insertBefore(permission, $('.composer-box'));
  checkbox.title = 'Permit safe selected file contents to be included in this one request. Secrets/keyfiles remain excluded.';
  const stop = graphicAction(el('button', 'chat-stop'), 'Stop','stop','Stop current VEYL request'); stop.id = 'chat-stop'; stop.hidden = true; $('.composer-footer').insertBefore(stop, $('#chat-send'));
  stop.onclick = () => { if (chatJob) api.librarian.cancel(chatJob.id).catch(error => toast(error.message, true)); };
  $('#chat-send').title = 'Send to VEYL (Enter)'; $('#chat-send').onclick = sendChat;
  $('#chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendChat(); } });
  api.librarian.onUpdate(async update => {
    if (!chatJob) return;
    if (!chatJob.id) chatJob.id = update.id;
    if (chatJob.id !== update.id) return;
    if (update.type === 'status') {
      chatStatus(update.message, 'working');
      if (update.applying) { chatApplying = true; busy = true; updateToolbar(); }
    } else if (update.type === 'result') {
      const extra = el('div', 'chat-result-extra');
      if (update.evidence?.length) extra.append(el('div', 'chat-evidence', update.evidence.map(evidence => `${evidence.action}: ${evidence.error ? evidence.error.message : evidence.count !== undefined ? `${evidence.count} entries${evidence.limited ? ' · limited' : ''}` : 'observed'}`).join('\n')));
      if (update.plan) {
        chatPlan = update.plan;
        const label = el('div', 'plan-not-applied', `${update.plan.steps.length} proposed ${update.plan.steps.length === 1 ? 'step' : 'steps'} · Not applied`); label.dataset.planToken = update.plan.token; extra.append(label);
        const review = el('button', 'review-plan-button', update.plan.destructive ? 'Review changes & Trash…' : 'Review exact changes…');
        review.dataset.planToken = update.plan.token;
        review.onclick = () => reviewChatPlan(update.plan); extra.append(review);
      }
      addChatMessage('assistant', update.reply, extra);
      if (update.views?.length) {
        if (sameChatContext(chatSnapshot)) applyChatViews(update.views).catch(error => addChatMessage('error', error.message));
        else addChatMessage('result', 'The visible workspace changed while planning. Suggested view actions were skipped; ask again in the current folder.');
      }
      chatStatus(update.clarification ? 'Waiting for your clarification' : update.plan ? 'Preview awaits review' : update.executing ? 'Executing requested changes' : 'Connected · request complete');
      updateChatContext();
    } else if (update.type === 'step') {
      const result = update.result;
      addChatMessage(result.errors.length ? 'error' : 'result', `Step ${result.step} · ${result.action}: ${result.changes.length} completed${result.errors.length ? ` · ${result.errors.length} failed` : ''}${result.errors.length ? `\n${result.errors.map(error => `${error.path}: ${error.message}${error.partial?.destination ? `\nRecovery copy: ${error.partial.destination}` : ''}`).join('\n')}` : ''}`);
      $('#undo').dataset.available = result.undoAvailable ? 'yes' : '';
    } else if (update.type === 'applied') {
      retireChatPlan(chatPlan, 'Applied · changes completed'); chatPlan = null; addChatMessage('result', update.message); chatStatus('Requested changes completed');
    } else if (update.type === 'error' || update.type === 'cancelled') {
      retireChatPlan(chatPlan, chatApplying ? 'Stopped · inspect actual step results' : 'Cancelled/expired · not applied'); chatPlan = null; addChatMessage(update.type === 'error' ? 'error' : 'result', update.message || update.error.message); chatStatus(update.type === 'error' ? 'Request needs attention' : 'Cancelled', update.type === 'error' ? 'error' : 'ready');
    } else if (update.type === 'warning') {
      addChatMessage('error', update.message);
    } else if (update.type === 'done') {
      // Keep the composer busy until the visible snapshot reflects actual mutations.
      // Otherwise a fast second request can retain renamed/removed source identities.
      if (chatApplying || update.applying) {
        chatApplying = false; busy = true;
        try { await refreshAll((update.results || []).flatMap(result => result.changes || [])); }
        catch (error) { toast(error.message, true); }
        finally { busy = false; }
      }
      chatJob = null; chatBusy(false);
      updateToolbar();
    }
  });
  try {
    const state = await api.librarian.boot(); chatAvailable = state.status.available; chatScope = state.scope;
    $('.librarian-header small').textContent = `${state.status.model} · ${state.status.reasoning || 'configured effort'}`;
    $('#chat-messages').replaceChildren();
    if (state.messages.length) for (const message of state.messages) addChatMessage(message.role, message.text);
    else addChatMessage('assistant', 'Find. Organize. Ask for a preview if wanted.');
    if (chatAvailable) {
      $('.librarian-header small').textContent = `${state.status.model} · ${state.status.reasoning || 'configured effort'}`;
      chatStatus(`Ready · ${state.status.provider}`);
    } else { chatStatus(`${state.status.provider || 'Provider'} needs attention`, 'error'); addChatMessage('error', state.status.message); }
    chatBusy(false);
    if (state.warning) addChatMessage('error', state.warning);
  } catch (error) { chatAvailable = false; chatStatus('Connection failed', 'error'); addChatMessage('error', error.message); }
}
async function sendChat() {
  const text = $('#chat-input').value.trim();
  if (!text || chatJob || !chatAvailable) return;
  if (activePane.path === 'trash:') { addChatMessage('result', 'Choose a filesystem folder before requesting file work. Trash restoration is available in the explorer.'); return; }
  if (busy) return toast('Wait for the current file operation before requesting a plan.');
  chatSnapshot = chatContext();
  if ($('#chat-content-toggle').checked) chatSnapshot.contentPaths = [...activePane.selection];
  $('#chat-content-toggle').checked = false; retireChatPlan(chatPlan, 'Superseded · ask for a fresh plan'); chatPlan = null;
  addChatMessage('user', text); $('#chat-input').value = ''; chatJob = { id: null }; chatBusy(true); chatStatus('Preparing scoped context…', 'working');
  try { const result = await api.librarian.send({ text, context: chatSnapshot }); if (chatJob) chatJob.id = result.id; }
  catch (error) { chatJob = null; chatBusy(false); chatStatus('Request failed', 'error'); addChatMessage('error', error.message); }
}
async function reviewChatPlan(plan) {
  if (chatJob || busy) return;
  if (!sameChatContext(chatSnapshot)) { addChatMessage('result', 'The folder, selection, or view changed. Ask VEYL to create a fresh plan.'); return; }
  const description = plan.steps.map((step, index) => `${index + 1}. ${step.action}${step.format ? ` (${step.format.toUpperCase()})` : ''}\n${(step.paths || []).join('\n')}${step.targets?.length ? `\n→ ${step.targets.join('\n→ ')}` : step.destination ? `\n→ ${step.destination}` : step.action === 'trash' ? '\n→ Recoverable Trash' : ''}${step.action==='edit-text'?`\nReplacement text (${new TextEncoder().encode(step.content).length} UTF-8 bytes):\n${step.content}`:''}`).join('\n\n');
  const confirmed = await dialog({ title: 'Review exact file changes', description: `${description}\n\nScope: ${plan.scope.join(', ')}\n${plan.destructive ? 'Trash steps remove entries from their current location; restoration remains available.\n' : ''}${plan.steps.some(step=>step.action==='edit-text')?'Text replacements modify only their identity-bound source; original bytes support guarded Undo.':'No existing destination will be overwritten.'} If a step fails, later steps stop.`, confirm: plan.destructive ? 'Apply changes & Trash' : 'Apply reviewed plan', icon: plan.destructive ? 'trash' : 'check', danger: plan.destructive });
  if (!confirmed) { await api.librarian.cancel().catch(() => {}); retireChatPlan(plan, 'Cancelled · no proposed changes applied'); chatPlan = null; addChatMessage('result', 'Plan cancelled. No proposed changes were applied.'); return; }
  retireChatPlan(plan, 'Applying reviewed changes…');
  chatJob = { id: null }; chatApplying = true; busy = true; chatBusy(true); updateToolbar();
  try { const result = await api.librarian.approve({ token: plan.token, context: chatContext() }); if (chatJob) chatJob.id = result.id; }
  catch (error) { retireChatPlan(plan, 'Expired/changed · ask for a fresh plan'); chatJob = null; chatApplying = false; busy = false; chatPlan = null; chatBusy(false); updateToolbar(); addChatMessage('error', error.message); }
}
async function applyChatViews(views) {
  for (const action of views) {
    if (action.action === 'navigate') await navigate(activePane, action.path);
    else if (action.action === 'sort') { activePane.sort = action.sort; activePane.direction = action.direction || 'asc'; await load(activePane); }
    else if (action.action === 'view') setView(action.view);
    else if (action.action === 'select') {
      const entries = await Promise.all(action.paths.map(file => api.properties(file)));
      if (entries.some(entry => !activePane.entries.some(current => current.path === entry.path))) {
        activePane.entries = entries; activePane.total = entries.length; activePane.nextOffset = null; activePane.search = { id: null, query: 'VEYL matches', source: 'librarian', done: true }; renderPane(activePane);
      }
      activePane.selection = new Set(action.paths); activePane.focused = action.paths[0]; updateSelection(activePane); renderPane(activePane);
    }
  }
  addChatMessage('result', `Updated the explorer · ${views.map(action => action.action).join(', ')}.`);
}

// Only visible panes are watched; reloads preserve selected visible entries and scroll.
let watchPaths='', externalTimer=null, externalRefreshing=false;
const changedFolders=new Set();
function visiblePanes(){return [tabs.find(tab=>tab.id===selectedTab),...(dual?[secondary]:[])].filter(Boolean);}
function syncWatches(){const paths=visiblePanes().filter(p=>p.path!=='trash:').map(p=>p.path);const key=JSON.stringify(paths);if(key===watchPaths)return;watchPaths=key;api.watchFolders(paths).catch(error=>toast(error.message,true));}
function queueExternalRefresh(paths){for(const file of paths)changedFolders.add(file);clearTimeout(externalTimer);externalTimer=setTimeout(flushExternalRefresh,350);}
async function flushExternalRefresh(){
  if(externalRefreshing||busy||chatApplying||visiblePanes().some(p=>p.loading)){externalTimer=setTimeout(flushExternalRefresh,350);return;}
  externalRefreshing=true;
  try {
  const paths=new Set(changedFolders);changedFolders.clear();
  const candidates=visiblePanes().filter(p=>paths.has(p.path)&&!p.search),panes=[];
  for(const pane of candidates){
    const version=pane.version,folder=pane.path;
    try {const probe=await api.list({path:folder,limit:Math.min(1000,Math.max(240,pane.entries.length)),sort:pane.sort,direction:pane.direction,hidden,filter:pane.filter,refresh:true});
      while(probe.nextOffset!==null&&probe.entries.length<pane.entries.length){const next=await api.list({path:folder,offset:probe.nextOffset,limit:Math.min(1000,pane.entries.length-probe.entries.length),sort:pane.sort,direction:pane.direction,hidden,filter:pane.filter});probe.entries.push(...next.entries);probe.nextOffset=next.nextOffset;}
      if(pane.version!==version||pane.path!==folder)continue;
      const comparable=pane.entries.slice(0,probe.entries.length);
      if(probe.total!==pane.total||probe.entries.length!==comparable.length||probe.entries.some((entry,index)=>entry.path!==comparable[index]?.path||entry.identity!==comparable[index]?.identity))panes.push(pane);
    }catch{panes.push(pane);}
  }
  if(!panes.length)return;
  if(chatPlan){retireChatPlan(chatPlan,'Folder changed · ask for a fresh plan');chatPlan=null;await api.librarian.cancel().catch(()=>{});addChatMessage('result','Folder contents changed outside the current review. Request a fresh proposal before applying.');}
  await Promise.all(panes.map(p=>load(p,{refresh:true,preserveSelection:true})));showInspector();
  } finally { externalRefreshing=false;if(changedFolders.size){clearTimeout(externalTimer);externalTimer=setTimeout(flushExternalRefresh,350);} }
}
api.onFolderChanged(update=>{if(update.warning)toast(update.warning);queueExternalRefresh(update.paths);});
window.addEventListener('focus',()=>{api.clipboardFiles().then(value=>{clipboard=value;updateToolbar();}).catch(()=>{});queueExternalRefresh(visiblePanes().map(p=>p.path));});
