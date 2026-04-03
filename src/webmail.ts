export function getWebmailHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Webmail</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg-1: #f4f7fb;
      --bg-2: #e8f1fb;
      --panel: #ffffff;
      --border: #dbe6f1;
      --text: #0f172a;
      --muted: #5f7388;
      --accent: #0284c7;
      --accent-2: #0ea5e9;
      --danger: #dc2626;
      --sidebar-1: #0e2a44;
      --sidebar-2: #0b2138;
      --sidebar-text: #dbe8f6;
    }

    body {
      font-family: 'Segoe UI Variable', 'Trebuchet MS', 'Segoe UI', sans-serif;
      min-height: 100vh;
      color: var(--text);
      background:
        radial-gradient(circle at 5% 10%, #ffffff 0%, #ffffff88 28%, transparent 55%),
        radial-gradient(circle at 95% 5%, #d9f1ff 0%, #d9f1ff66 35%, transparent 62%),
        linear-gradient(180deg, var(--bg-2), var(--bg-1));
    }

    #login {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      width: 100vw;
      position: fixed;
      top: 0;
      left: 0;
      z-index: 250;
      background: rgba(244, 247, 251, 0.95);
      backdrop-filter: blur(4px);
    }

    .login-box {
      width: min(360px, calc(100vw - 30px));
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 14px;
      box-shadow: 0 18px 40px rgba(15, 23, 42, 0.12);
      padding: 28px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .login-box h2 { font-size: 22px; font-weight: 800; letter-spacing: 0.2px; }
    .login-sub { color: var(--muted); font-size: 13px; margin-bottom: 4px; }

    #app {
      display: none;
      width: 100%;
      height: 100vh;
      padding: 14px;
      gap: 12px;
    }

    #sidebar {
      width: 236px;
      border-radius: 16px;
      background: linear-gradient(180deg, var(--sidebar-1), var(--sidebar-2) 58%);
      color: var(--sidebar-text);
      border: 1px solid #163759;
      box-shadow: 0 12px 28px rgba(2, 12, 27, 0.22);
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
    }

    .brand {
      font-size: 19px;
      font-weight: 800;
      letter-spacing: 0.2px;
      margin-bottom: 4px;
    }

    .folder-btn {
      width: 100%;
      background: transparent;
      border: 0;
      color: #b4c6da;
      padding: 10px 12px;
      border-radius: 10px;
      cursor: pointer;
      text-align: left;
      font-size: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      transition: background 0.15s ease, color 0.15s ease;
    }

    .folder-btn:hover,
    .folder-btn.active {
      background: #17476f;
      color: #f4f9ff;
    }

    .folder-badge {
      min-width: 20px;
      text-align: center;
      font-size: 11px;
      border-radius: 999px;
      padding: 3px 7px;
      background: #0b2138;
      color: #d6ebfd;
      border: 1px solid #3b5d7e;
    }

    #mailMain {
      flex: 1;
      min-width: 0;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: 0 12px 28px rgba(15, 23, 42, 0.08);
      overflow: hidden;
      display: flex;
    }

    #listPane {
      width: 360px;
      min-width: 280px;
      border-right: 1px solid #e2e8f0;
      display: flex;
      flex-direction: column;
      background: #fff;
    }

    .list-toolbar {
      border-bottom: 1px solid #e2e8f0;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    #folderTitle {
      font-size: 18px;
      font-weight: 800;
      color: #10253c;
    }

    #listSearch {
      width: 100%;
      padding: 9px 10px;
      border-radius: 9px;
      border: 1px solid #d4dee9;
      background: #f8fbff;
      color: #0f172a;
      font-size: 13px;
    }

    #listSearch:focus {
      outline: 2px solid #bae6fd;
      outline-offset: 1px;
      border-color: #7dd3fc;
    }

    #list {
      overflow-y: auto;
      flex: 1;
    }

    .list-empty {
      padding: 18px 14px;
      font-size: 13px;
      color: #73879c;
    }

    .email-row {
      padding: 12px 14px;
      border-bottom: 1px solid #eff4f9;
      cursor: pointer;
      transition: background 0.14s ease;
    }

    .email-row:hover { background: #f5f9fe; }
    .email-row.selected {
      background: #e9f6ff;
      border-left: 3px solid var(--accent);
      padding-left: 11px;
    }

    .email-row.unread .email-from,
    .email-row.unread .email-subject {
      font-weight: 700;
      color: #0f2238;
    }

    .email-from,
    .email-subject,
    .email-date {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .email-from { font-size: 13px; color: #10253c; }
    .email-subject { font-size: 12px; color: #5e7388; margin-top: 2px; }
    .email-date { font-size: 11px; color: #8ba0b5; margin-top: 4px; }

    #viewerPane {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      background: #fff;
    }

    .mobile-back-btn {
      display: none;
      margin: 10px 12px 0;
      width: max-content;
    }

    #viewer {
      flex: 1;
      overflow-y: auto;
      padding: 22px 24px;
    }

    .viewer-empty {
      color: #8297ab;
      font-size: 14px;
      padding-top: 18px;
    }

    .viewer-header {
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 14px;
      margin-bottom: 14px;
    }

    .viewer-subject {
      font-size: 23px;
      font-weight: 800;
      color: #0f2238;
      line-height: 1.2;
    }

    .viewer-meta {
      color: #5f7388;
      font-size: 13px;
      margin-top: 6px;
      line-height: 1.5;
    }

    .viewer-actions {
      margin-top: 10px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .viewer-body {
      font-size: 14px;
      color: #1f3347;
      line-height: 1.64;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .attachment-list {
      margin-top: 16px;
      border-top: 1px solid #e2e8f0;
      padding-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .attachment-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      border: 1px solid #dbe6f1;
      border-radius: 10px;
      background: #f8fbff;
      padding: 8px 10px;
    }

    .attachment-meta { min-width: 0; }
    .attachment-name {
      font-size: 13px;
      color: #0f2238;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .attachment-size {
      font-size: 11px;
      color: #6c8296;
      margin-top: 2px;
    }

    #compose {
      display: none;
      position: fixed;
      right: 22px;
      bottom: 0;
      width: min(540px, calc(100vw - 24px));
      background: #fff;
      border: 1px solid #d6e2ee;
      border-radius: 14px 14px 0 0;
      box-shadow: 0 -8px 26px rgba(15, 23, 42, 0.18);
      z-index: 160;
    }

    .compose-header {
      border-radius: 14px 14px 0 0;
      padding: 11px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      color: #f3f9ff;
      background: linear-gradient(180deg, var(--sidebar-1), var(--sidebar-2));
    }

    .compose-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
    }

    .compose-title strong { font-size: 14px; }

    #composeTag {
      font-size: 11px;
      border-radius: 999px;
      border: 1px solid #3a6287;
      background: #0f3455;
      padding: 2px 7px;
    }

    .compose-header-actions {
      display: flex;
      align-items: center;
      gap: 7px;
    }

    .compose-link {
      border: 0;
      background: transparent;
      color: #d9ecfe;
      font-size: 12px;
      cursor: pointer;
      padding: 4px 6px;
      border-radius: 6px;
    }

    .compose-link:hover { background: #164469; }

    .compose-body {
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .compose-body input,
    .compose-body textarea,
    .compose-body select {
      width: 100%;
      border: 1px solid #d4dee9;
      border-radius: 8px;
      padding: 9px;
      font-size: 13px;
      font-family: inherit;
      color: #0f172a;
      background: #fff;
    }

    .compose-body textarea {
      min-height: 130px;
      resize: vertical;
    }

    .compose-from-row {
      align-items: center;
      gap: 10px;
    }

    .compose-from-row label {
      font-size: 12px;
      color: #5f7388;
      min-width: 42px;
    }

    .compose-from-row select {
      flex: 1;
      min-width: 0;
    }

    .compose-file-hint {
      font-size: 11px;
      color: #6d8297;
    }

    .compose-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    #sendStatus {
      font-size: 12px;
      color: #607489;
    }

    .btn {
      border: 0;
      border-radius: 8px;
      padding: 8px 13px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: filter 0.15s ease;
    }

    .btn:hover { filter: brightness(0.96); }
    .btn-primary {
      background: linear-gradient(180deg, var(--accent-2), var(--accent));
      color: #fff;
    }

    .btn-secondary {
      background: #e5edf6;
      color: #17344f;
    }

    .btn-danger {
      background: linear-gradient(180deg, #ef4444, var(--danger));
      color: #fff;
    }

    input[type=text],
    input[type=password] {
      width: 100%;
      border: 1px solid #d4dee9;
      border-radius: 8px;
      padding: 10px;
      font-size: 14px;
      background: #fff;
      color: #0f172a;
    }

    @media (max-width: 980px) {
      #app {
        height: auto;
        min-height: 100vh;
        flex-direction: column;
        padding: 8px;
      }

      #sidebar {
        width: 100%;
        flex-direction: row;
        flex-wrap: wrap;
        align-items: center;
        padding: 10px;
        border-radius: 12px;
      }

      .brand {
        width: 100%;
        margin-bottom: 2px;
      }

      #mailMain {
        min-height: calc(100vh - 178px);
      }

      #listPane {
        width: 310px;
        min-width: 260px;
      }
    }

    @media (max-width: 760px) {
      #app {
        padding: 0;
        gap: 0;
      }

      #sidebar {
        border-radius: 0;
        border-left: 0;
        border-right: 0;
        border-top: 0;
        position: sticky;
        top: 0;
        z-index: 20;
        box-shadow: 0 6px 18px rgba(2, 12, 27, 0.24);
      }

      #mailMain {
        border-radius: 0;
        border-left: 0;
        border-right: 0;
        border-bottom: 0;
        min-height: calc(100vh - 136px);
      }

      #listPane,
      #viewerPane {
        width: 100%;
        min-width: 0;
      }

      #app.mobile-list #viewerPane { display: none; }
      #app.mobile-viewer #listPane { display: none; }

      .mobile-back-btn { display: inline-flex; }

      #viewer { padding: 16px; }

      .viewer-subject { font-size: 20px; }

      #compose {
        right: 0;
        width: 100%;
        max-width: none;
        height: 100%;
        border-radius: 0;
      }

      .compose-header { border-radius: 0; }

      .compose-body {
        height: calc(100% - 52px);
        overflow-y: auto;
      }
    }
  </style>
</head>
<body>

<div id="login">
  <div class="login-box">
    <h2>Webmail Login</h2>
    <div class="login-sub">Sign in to manage inbox, drafts, and sent mail.</div>
    <form id="loginForm" style="display:flex;flex-direction:column;gap:10px;">
      <input id="loginUser" type="text" placeholder="Username" autocomplete="username" />
      <input id="loginPass" type="password" placeholder="Password" autocomplete="current-password" />
      <button class="btn btn-primary" id="loginBtn" type="submit">Sign In</button>
    </form>
    <div id="loginError" style="color:#dc2626;font-size:13px;min-height:18px;"></div>
  </div>
</div>

<div id="app" class="mobile-list">
  <div id="sidebar">
    <div class="brand">Webmail</div>
    <button class="folder-btn active" data-folder="inbox" id="folderInboxBtn"><span>Inbox</span></button>
    <button class="folder-btn" data-folder="sent" id="folderSentBtn"><span>Sent</span></button>
    <button class="folder-btn" data-folder="drafts" id="folderDraftsBtn"><span>Drafts</span><span class="folder-badge" id="draftCount">0</span></button>
    <button class="folder-btn" data-folder="trash" id="folderTrashBtn"><span>Trash</span></button>
    <div style="flex:1;"></div>
    <button class="btn btn-primary" id="composeOpenBtn" style="width:100%;">Compose</button>
    <button class="folder-btn" id="logoutBtn" style="margin-top:6px;"><span>Sign Out</span></button>
  </div>

  <div id="mailMain">
    <section id="listPane">
      <div class="list-toolbar">
        <div id="folderTitle">Inbox</div>
        <input id="listSearch" type="text" placeholder="Search in this folder" />
      </div>
      <div id="list"><div class="list-empty">Loading...</div></div>
    </section>

    <section id="viewerPane">
      <button class="btn btn-secondary mobile-back-btn" id="mobileBackBtn" type="button">Back to list</button>
      <div id="viewer"><div class="viewer-empty">Select an email to read it.</div></div>
    </section>
  </div>
</div>

<div id="compose">
  <div class="compose-header">
    <div class="compose-title">
      <strong>Compose</strong>
      <span id="composeTag">New</span>
    </div>
    <div class="compose-header-actions">
      <button class="compose-link" id="saveDraftBtn" type="button">Save Draft</button>
      <button class="compose-link" id="closeComposeBtn" type="button">Close</button>
    </div>
  </div>

  <div class="compose-body">
    <input id="composeTo" type="text" placeholder="To" />
    <input id="composeSubject" type="text" placeholder="Subject" />
    <div class="compose-row compose-from-row">
      <label for="composeFrom">From</label>
      <select id="composeFrom"></select>
    </div>
    <textarea id="composeBody" placeholder="Write your message..."></textarea>
    <input id="composeFiles" type="file" multiple />
    <div class="compose-file-hint">Attach up to 10 files, max 20 MB total. Drafts store To/Subject/Body text only.</div>
    <div class="compose-row">
      <button class="btn btn-primary" id="sendBtn" type="button">Send</button>
      <button class="btn btn-secondary" id="discardDraftBtn" type="button">Discard</button>
      <div id="sendStatus"></div>
    </div>
  </div>
</div>

<script>
  let TOKEN = '';
  let currentFolder = 'inbox';
  let selectedEmailId = null;
  let selectedDraftId = null;
  let activeDraftId = null;
  let currentListItems = [];
  let viewerContext = null;
  let draftAutosaveTimer = null;
  let availableSenderAddresses = [];
  let activeSenderAddress = '';
  const DRAFTS_KEY = 'webmail.local-drafts.v1';

  function byId(id) {
    return document.getElementById(id);
  }

  function normalizeAddress(value) {
    return String(value || '').trim().toLowerCase();
  }

  function deriveSenderAddresses(payload) {
    const candidates = [];

    if (payload && Array.isArray(payload.emails)) {
      for (const value of payload.emails) {
        const normalized = normalizeAddress(value);
        if (normalized) {
          candidates.push(normalized);
        }
      }
    }

    const primary = payload && typeof payload.email === 'string' ? normalizeAddress(payload.email) : '';
    if (primary) {
      candidates.unshift(primary);
    }

    const deduped = [];
    const seen = new Set();
    for (const address of candidates) {
      if (!seen.has(address)) {
        seen.add(address);
        deduped.push(address);
      }
    }

    return deduped;
  }

  function renderFromAddressOptions() {
    const select = byId('composeFrom');
    if (!select) return;

    select.innerHTML = '';

    if (!availableSenderAddresses.length) {
      const emptyOption = document.createElement('option');
      emptyOption.value = '';
      emptyOption.textContent = '(no sender address)';
      select.appendChild(emptyOption);
      select.disabled = true;
      return;
    }

    if (!availableSenderAddresses.includes(activeSenderAddress)) {
      activeSenderAddress = availableSenderAddresses[0];
    }

    for (const address of availableSenderAddresses) {
      const option = document.createElement('option');
      option.value = address;
      option.textContent = address;
      option.selected = address === activeSenderAddress;
      select.appendChild(option);
    }

    select.disabled = false;
    select.value = activeSenderAddress;
  }

  function setSenderAddressesFromPayload(payload) {
    availableSenderAddresses = deriveSenderAddresses(payload);

    if (!availableSenderAddresses.length) {
      activeSenderAddress = '';
    } else if (!availableSenderAddresses.includes(activeSenderAddress)) {
      activeSenderAddress = availableSenderAddresses[0];
    }

    renderFromAddressOptions();
  }

  function selectedFromAddress() {
    const select = byId('composeFrom');
    if (select && !select.disabled) {
      const normalized = normalizeAddress(select.value);
      if (normalized) {
        activeSenderAddress = normalized;
      }
    }

    return activeSenderAddress;
  }

  function folderTitle(folder) {
    if (folder === 'sent') return 'Sent';
    if (folder === 'drafts') return 'Drafts';
    if (folder === 'trash') return 'Trash';
    return 'Inbox';
  }

  function isMobileViewport() {
    return window.matchMedia('(max-width: 760px)').matches;
  }

  function setMobilePane(pane) {
    const app = byId('app');
    if (!app) return;

    if (!isMobileViewport()) {
      app.classList.remove('mobile-list');
      app.classList.remove('mobile-viewer');
      return;
    }

    app.classList.toggle('mobile-list', pane === 'list');
    app.classList.toggle('mobile-viewer', pane === 'viewer');
  }

  function syncMobilePaneFromSelection() {
    if (selectedEmailId !== null || selectedDraftId !== null) {
      setMobilePane('viewer');
      return;
    }

    setMobilePane('list');
  }

  function setSendStatus(message, isError) {
    const status = byId('sendStatus');
    if (!status) return;

    status.textContent = String(message || '');
    status.style.color = isError ? '#dc2626' : '#607489';
  }

  function addSubjectPrefix(subject, prefix) {
    const s = String(subject || '').trim();
    const p = prefix + ': ';
    return s.toLowerCase().startsWith(p.toLowerCase()) ? s : (p + s);
  }

  function quotedBlock(metaLabel, addr, timestamp, bodyText) {
    const intro = '\\n\\n--- Original message ---\\n';
    const when = timestamp ? new Date(timestamp).toLocaleString() : '';
    const header = metaLabel + ': ' + String(addr || '') + (when ? ('\\nDate: ' + when) : '') + '\\n\\n';
    const content = String(bodyText || '(empty)')
      .split('\\n')
      .map((line) => '> ' + line)
      .join('\\n');
    return intro + header + content;
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderViewerPlaceholder(message) {
    viewerContext = null;
    const viewer = byId('viewer');
    if (!viewer) return;

    viewer.innerHTML = '<div class="viewer-empty">' + esc(message) + '</div>';
  }

  function newDraftId() {
    return 'draft_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  function loadDrafts() {
    let parsed = [];
    try {
      const raw = localStorage.getItem(DRAFTS_KEY);
      parsed = raw ? JSON.parse(raw) : [];
    } catch {
      parsed = [];
    }

    if (!Array.isArray(parsed)) {
      return [];
    }

    const drafts = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const id = typeof item.id === 'string' && item.id.trim().length > 0 ? item.id : newDraftId();
      const createdAt = typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString();
      const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : createdAt;

      drafts.push({
        id,
        to: String(item.to || ''),
        subject: String(item.subject || ''),
        text: String(item.text || ''),
        createdAt,
        updatedAt,
      });
    }

    drafts.sort((a, b) => {
      const left = Date.parse(b.updatedAt || '');
      const right = Date.parse(a.updatedAt || '');
      return (Number.isNaN(left) ? 0 : left) - (Number.isNaN(right) ? 0 : right);
    });

    return drafts;
  }

  function saveDrafts(drafts) {
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(Array.isArray(drafts) ? drafts : []));
    } catch {
      // Ignore localStorage failures.
    }

    renderDraftCount();
  }

  function renderDraftCount() {
    const count = loadDrafts().length;
    const badge = byId('draftCount');
    if (badge) {
      badge.textContent = String(count);
    }
  }

  function getDraftById(draftId) {
    return loadDrafts().find((draft) => draft.id === draftId) || null;
  }

  function removeDraftById(draftId) {
    const drafts = loadDrafts().filter((draft) => draft.id !== draftId);
    saveDrafts(drafts);
  }

  function readComposeFields() {
    const toInput = byId('composeTo');
    const subjectInput = byId('composeSubject');
    const bodyInput = byId('composeBody');

    return {
      to: toInput ? String(toInput.value || '').trim() : '',
      subject: subjectInput ? String(subjectInput.value || '').trim() : '',
      text: bodyInput ? String(bodyInput.value || '').trim() : '',
    };
  }

  function composeHasContent(composeState) {
    return Boolean(composeState.to || composeState.subject || composeState.text);
  }

  function clearComposeFields() {
    const toInput = byId('composeTo');
    const subjectInput = byId('composeSubject');
    const bodyInput = byId('composeBody');
    const filesInput = byId('composeFiles');

    if (toInput) toInput.value = '';
    if (subjectInput) subjectInput.value = '';
    if (bodyInput) bodyInput.value = '';
    if (filesInput) filesInput.value = '';
  }

  function renderComposeTag() {
    const composeTag = byId('composeTag');
    if (!composeTag) return;

    composeTag.textContent = activeDraftId ? 'Draft' : 'New';
  }

  function openCompose() {
    const compose = byId('compose');
    if (!compose) return;
    compose.style.display = 'block';
    renderFromAddressOptions();
    renderComposeTag();
  }

  function closeCompose(skipAutosave) {
    if (!skipAutosave) {
      saveDraft(false);
    }

    if (draftAutosaveTimer) {
      clearTimeout(draftAutosaveTimer);
      draftAutosaveTimer = null;
    }

    const compose = byId('compose');
    if (compose) {
      compose.style.display = 'none';
    }
  }

  function beginNewCompose() {
    activeDraftId = null;
    clearComposeFields();
    setSendStatus('', false);
    renderComposeTag();
    openCompose();

    const toInput = byId('composeTo');
    if (toInput) toInput.focus();
  }

  function editDraft(draftId) {
    const draft = getDraftById(draftId);
    if (!draft) {
      if (currentFolder === 'drafts') {
        loadFolder('drafts');
      }
      return;
    }

    activeDraftId = draft.id;

    const toInput = byId('composeTo');
    const subjectInput = byId('composeSubject');
    const bodyInput = byId('composeBody');

    if (toInput) toInput.value = draft.to;
    if (subjectInput) subjectInput.value = draft.subject;
    if (bodyInput) bodyInput.value = draft.text;

    setSendStatus('Editing draft', false);
    renderComposeTag();
    openCompose();

    if (bodyInput) bodyInput.focus();
  }

  function saveDraft(manual) {
    const state = readComposeFields();

    if (!composeHasContent(state)) {
      if (activeDraftId) {
        removeDraftById(activeDraftId);
        activeDraftId = null;
      }

      renderComposeTag();
      if (manual) {
        setSendStatus('Nothing to save', false);
      }

      if (currentFolder === 'drafts') {
        loadFolder('drafts');
      }
      return false;
    }

    const drafts = loadDrafts();
    const now = new Date().toISOString();
    const targetId = activeDraftId || newDraftId();
    const existing = drafts.find((draft) => draft.id === targetId);

    const savedDraft = {
      id: targetId,
      to: state.to,
      subject: state.subject,
      text: state.text,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    const nextDrafts = drafts.filter((draft) => draft.id !== targetId);
    nextDrafts.push(savedDraft);
    nextDrafts.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    saveDrafts(nextDrafts);

    activeDraftId = targetId;
    renderComposeTag();

    if (manual) {
      setSendStatus('Draft saved at ' + new Date().toLocaleTimeString(), false);
    }

    if (currentFolder === 'drafts') {
      loadFolder('drafts');
    }

    return true;
  }

  function discardDraft() {
    const state = readComposeFields();
    if (!composeHasContent(state) && !activeDraftId) {
      closeCompose(true);
      return;
    }

    if (!window.confirm('Discard this draft?')) {
      return;
    }

    if (activeDraftId) {
      removeDraftById(activeDraftId);
      if (selectedDraftId === activeDraftId) {
        selectedDraftId = null;
      }
    }

    activeDraftId = null;
    clearComposeFields();
    renderComposeTag();
    setSendStatus('Draft discarded', false);

    if (currentFolder === 'drafts') {
      loadFolder('drafts');
      renderViewerPlaceholder('Select a draft to preview it.');
    }
  }

  function scheduleDraftAutosave() {
    const compose = byId('compose');
    if (!compose || compose.style.display === 'none') {
      return;
    }

    if (draftAutosaveTimer) {
      clearTimeout(draftAutosaveTimer);
    }

    draftAutosaveTimer = setTimeout(() => {
      saveDraft(false);
    }, 1000);
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function parseAttachmentFilename(contentDisposition) {
    const value = String(contentDisposition || '');
    if (!value) return 'attachment';

    const encodedMatch = /filename\*=UTF-8''([^;]+)/i.exec(value);
    if (encodedMatch) {
      try {
        return decodeURIComponent(encodedMatch[1]);
      } catch {
        return 'attachment';
      }
    }

    const plainMatch = /filename="?([^";]+)"?/i.exec(value);
    return plainMatch ? plainMatch[1] : 'attachment';
  }

  function renderAttachments(attachments) {
    if (!Array.isArray(attachments) || !attachments.length) {
      return '';
    }

    return '<div class="attachment-list"><div style="font-size:12px;font-weight:700;color:#12314f;">Attachments</div>' +
      attachments.map((attachment) => {
        const id = Number(attachment.id);
        const filename = String(attachment.filename || 'attachment');
        const size = formatBytes(Number(attachment.size_bytes || 0));
        return '<div class="attachment-item"><div class="attachment-meta"><div class="attachment-name">' + esc(filename) + '</div><div class="attachment-size">' + esc(size) + '</div></div><button class="btn btn-secondary" data-action="download-attachment" data-attachment-id="' + id + '">Download</button></div>';
      }).join('') +
      '</div>';
  }

  function renderBody(email) {
    if (email.body_html) {
      const srcdoc = String(email.body_html).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return '<iframe sandbox="" referrerpolicy="no-referrer" srcdoc="' + srcdoc + '" style="width:100%;min-height:360px;border:none;border-radius:8px;"></iframe>';
    }

    return esc(email.body_text || '(empty)');
  }

  function updateFolderUi(btn, folder) {
    currentFolder = folder;

    document.querySelectorAll('.folder-btn[data-folder]').forEach((item) => {
      item.classList.remove('active');
    });

    if (btn) {
      btn.classList.add('active');
    } else {
      const activeBtn = document.querySelector('.folder-btn[data-folder="' + folder + '"]');
      if (activeBtn) {
        activeBtn.classList.add('active');
      }
    }

    const folderTitleEl = byId('folderTitle');
    if (folderTitleEl) {
      folderTitleEl.textContent = folderTitle(folder);
    }

    const searchInput = byId('listSearch');
    if (searchInput) {
      searchInput.value = '';
    }
  }

  function renderList() {
    const list = byId('list');
    if (!list) return;

    const searchValue = byId('listSearch');
    const query = String(searchValue ? searchValue.value : '').trim().toLowerCase();
    const items = query
      ? currentListItems.filter((item) => item.search.includes(query))
      : currentListItems;

    if (!items.length) {
      list.innerHTML = '<div class="list-empty">' + (query ? 'No matching items in this folder.' : 'No messages here.') + '</div>';
      return;
    }

    list.innerHTML = items.map((item) => {
      const selected = item.type === 'draft'
        ? String(item.id) === String(selectedDraftId)
        : Number(item.id) === Number(selectedEmailId);
      const selectedClass = selected ? ' selected' : '';
      const unreadClass = item.unread ? ' unread' : '';
      const timestamp = item.timestamp ? new Date(item.timestamp).toLocaleString() : '';

      return '<div class="email-row' + unreadClass + selectedClass + '" data-row-id="' + esc(String(item.id)) + '" data-row-type="' + esc(String(item.type)) + '">' +
        '<div class="email-from">' + esc(item.primary) + '</div>' +
        '<div class="email-subject">' + esc(item.subject || '(no subject)') + '</div>' +
        '<div class="email-date">' + esc(timestamp) + '</div>' +
        '</div>';
    }).join('');
  }

  function setListItemsFromDrafts() {
    const drafts = loadDrafts();
    currentListItems = drafts.map((draft) => ({
      id: draft.id,
      type: 'draft',
      primary: draft.to ? ('To: ' + draft.to) : 'Draft',
      subject: draft.subject || '(no subject)',
      timestamp: draft.updatedAt,
      unread: false,
      search: [draft.to, draft.subject, draft.text].join(' ').toLowerCase(),
    }));
  }

  function setListItemsFromApi(rows) {
    if (currentFolder === 'sent') {
      currentListItems = rows.map((entry) => ({
        id: Number(entry.id),
        type: 'sent',
        primary: 'To: ' + String(entry.to_address || ''),
        subject: String(entry.subject || '(no subject)'),
        timestamp: entry.sent_at || '',
        unread: false,
        search: [entry.to_address, entry.subject].join(' ').toLowerCase(),
      }));
      return;
    }

    currentListItems = rows.map((entry) => ({
      id: Number(entry.id),
      type: 'email',
      primary: String(entry.from_name || entry.from_address || ''),
      subject: String(entry.subject || '(no subject)'),
      timestamp: entry.received_at || '',
      unread: !entry.read,
      search: [entry.from_name, entry.from_address, entry.subject].join(' ').toLowerCase(),
    }));
  }

  function markEmailReadInList(emailId) {
    for (const item of currentListItems) {
      if (item.type !== 'draft' && Number(item.id) === Number(emailId)) {
        item.unread = false;
      }
    }

    renderList();
  }

  async function loadFolder(folder, btn) {
    selectedEmailId = null;
    selectedDraftId = null;
    updateFolderUi(btn, folder);

    if (folder === 'drafts') {
      setListItemsFromDrafts();
      renderList();
      renderViewerPlaceholder('Select a draft to preview it.');
      setMobilePane('list');
      return;
    }

    const list = byId('list');
    if (list) {
      list.innerHTML = '<div class="list-empty">Loading...</div>';
    }

    const endpoint = folder === 'sent'
      ? '/api/sent'
      : '/api/emails?folder=' + encodeURIComponent(folder);

    const res = await apiFetch(endpoint);
    if (res.status === 401) {
      logout();
      return;
    }

    if (!res.ok) {
      if (list) {
        list.innerHTML = '<div class="list-empty" style="color:#dc2626;">Failed to load folder.</div>';
      }
      renderViewerPlaceholder('Unable to load this folder right now.');
      return;
    }

    const rows = await res.json().catch(() => []);
    setListItemsFromApi(Array.isArray(rows) ? rows : []);
    renderList();
    renderViewerPlaceholder('Select an email to read it.');
    setMobilePane('list');
  }

  function renderDraftViewer(draft) {
    const viewer = byId('viewer');
    if (!viewer) return;

    viewerContext = { type: 'draft', data: draft };
    const updated = draft.updatedAt ? new Date(draft.updatedAt).toLocaleString() : '(unknown)';

    viewer.innerHTML =
      '<div class="viewer-header">' +
        '<div class="viewer-subject">' + esc(draft.subject || '(no subject)') + '</div>' +
        '<div class="viewer-meta">' +
          'To: ' + esc(draft.to || '(empty)') + '<br>' +
          'Updated: ' + esc(updated) +
        '</div>' +
        '<div class="viewer-actions">' +
          '<button class="btn btn-primary" data-action="edit-draft">Edit</button>' +
          '<button class="btn btn-danger" data-action="delete-draft">Delete Draft</button>' +
        '</div>' +
      '</div>' +
      '<div class="viewer-body">' + esc(draft.text || '(empty draft)') + '</div>';
  }

  function renderSentViewer(sent) {
    const viewer = byId('viewer');
    if (!viewer) return;

    viewerContext = { type: 'sent', data: sent };
    const sentDate = sent.sent_at ? new Date(sent.sent_at).toLocaleString() : '(unknown)';

    viewer.innerHTML =
      '<div class="viewer-header">' +
        '<div class="viewer-subject">' + esc(sent.subject || '(no subject)') + '</div>' +
        '<div class="viewer-meta">' +
          'To: ' + esc(sent.to_address || '') + '<br>' +
          'Date: ' + esc(sentDate) +
        '</div>' +
        '<div class="viewer-actions">' +
          '<button class="btn btn-primary" data-action="reply">Reply</button>' +
          '<button class="btn btn-primary" data-action="forward">Forward</button>' +
          '<button class="btn btn-danger" data-action="delete-sent">Delete</button>' +
        '</div>' +
      '</div>' +
      '<div class="viewer-body">' + renderBody(sent) + '</div>' +
      renderAttachments(sent.attachments || []);
  }

  function renderInboxViewer(email) {
    const viewer = byId('viewer');
    if (!viewer) return;

    viewerContext = { type: 'email', data: email };
    const safeFrom = email.from_name
      ? (String(email.from_name) + ' <' + String(email.from_address || '') + '>')
      : String(email.from_address || '');

    const actionButtons = currentFolder === 'trash'
      ?
        '<button class="btn btn-secondary" data-action="restore-email">Restore</button>' +
        '<button class="btn btn-danger" data-action="delete-forever">Delete Forever</button>'
      : '<button class="btn btn-danger" data-action="delete-email">Delete</button>';

    viewer.innerHTML =
      '<div class="viewer-header">' +
        '<div class="viewer-subject">' + esc(email.subject || '(no subject)') + '</div>' +
        '<div class="viewer-meta">' +
          'From: ' + esc(safeFrom) + '<br>' +
          'To: ' + esc(email.to_address || '') + '<br>' +
          'Date: ' + esc(new Date(email.received_at || Date.now()).toLocaleString()) +
        '</div>' +
        '<div class="viewer-actions">' +
          '<button class="btn btn-primary" data-action="reply">Reply</button>' +
          '<button class="btn btn-primary" data-action="forward">Forward</button>' +
          actionButtons +
        '</div>' +
      '</div>' +
      '<div class="viewer-body">' + renderBody(email) + '</div>' +
      renderAttachments(email.attachments || []);
  }

  async function openDraftFromList(draftId) {
    const draft = getDraftById(draftId);
    if (!draft) {
      selectedDraftId = null;
      if (currentFolder === 'drafts') {
        loadFolder('drafts');
      }
      return;
    }

    selectedDraftId = draftId;
    selectedEmailId = null;
    renderList();
    renderDraftViewer(draft);
    setMobilePane('viewer');
  }

  async function loadEmail(emailId) {
    selectedEmailId = Number(emailId);
    selectedDraftId = null;

    renderList();

    if (currentFolder === 'sent') {
      const sentRes = await apiFetch('/api/sent/' + emailId);
      if (sentRes.status === 401) {
        logout();
        return;
      }

      if (!sentRes.ok) {
        renderViewerPlaceholder('Failed to load sent message.');
        return;
      }

      const sent = await sentRes.json();
      renderSentViewer(sent);
      setMobilePane('viewer');
      return;
    }

    const res = await apiFetch('/api/emails/' + emailId);
    if (res.status === 401) {
      logout();
      return;
    }

    if (!res.ok) {
      renderViewerPlaceholder('Failed to load message.');
      return;
    }

    const email = await res.json();
    renderInboxViewer(email);
    markEmailReadInList(email.id);
    setMobilePane('viewer');
  }

  async function downloadAttachment(attachmentId) {
    const res = await apiFetch('/api/attachments/' + Number(attachmentId) + '/download');
    if (res.status === 401) {
      logout();
      return;
    }

    if (!res.ok) {
      window.alert('Failed to download attachment.');
      return;
    }

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const filename = parseAttachmentFilename(res.headers.get('Content-Disposition'));
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = String(filename || 'attachment');
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  async function moveEmailToTrash(emailId) {
    if (!window.confirm('Move this email to trash?')) {
      return;
    }

    const res = await apiFetch('/api/emails/' + Number(emailId), 'DELETE');
    if (res.status === 401) {
      logout();
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Failed to delete email' }));
      window.alert(data.error || 'Failed to delete email');
      return;
    }

    selectedEmailId = null;
    await loadFolder(currentFolder);
    renderViewerPlaceholder('Email moved to trash.');
    setMobilePane('list');
  }

  async function deleteEmailForever(emailId) {
    if (!window.confirm('Permanently delete this email? This cannot be undone.')) {
      return;
    }

    const res = await apiFetch('/api/emails/' + Number(emailId) + '?hard=1', 'DELETE');
    if (res.status === 401) {
      logout();
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Failed to permanently delete email' }));
      window.alert(data.error || 'Failed to permanently delete email');
      return;
    }

    selectedEmailId = null;
    await loadFolder('trash');
    renderViewerPlaceholder('Email permanently deleted.');
    setMobilePane('list');
  }

  async function restoreEmailFromTrash(emailId) {
    const res = await apiFetch('/api/emails/' + Number(emailId) + '/restore', 'POST');
    if (res.status === 401) {
      logout();
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Failed to restore email' }));
      window.alert(data.error || 'Failed to restore email');
      return;
    }

    selectedEmailId = null;
    await loadFolder('trash');
    renderViewerPlaceholder('Email restored to Inbox.');
    setMobilePane('list');
  }

  async function deleteSentEmail(sentId) {
    if (!window.confirm('Delete this sent email?')) {
      return;
    }

    const res = await apiFetch('/api/sent/' + Number(sentId), 'DELETE');
    if (res.status === 401) {
      logout();
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Failed to delete sent email' }));
      window.alert(data.error || 'Failed to delete sent email');
      return;
    }

    selectedEmailId = null;
    await loadFolder('sent');
    renderViewerPlaceholder('Sent email deleted.');
    setMobilePane('list');
  }

  async function deleteDraftFromViewer(draftId) {
    if (!window.confirm('Delete this draft?')) {
      return;
    }

    removeDraftById(draftId);

    if (activeDraftId === draftId) {
      activeDraftId = null;
      renderComposeTag();
    }

    selectedDraftId = null;
    if (currentFolder === 'drafts') {
      await loadFolder('drafts');
    }

    renderViewerPlaceholder('Draft deleted.');
    setMobilePane('list');
  }

  function replyFromViewer() {
    if (!viewerContext) return;

    if (viewerContext.type === 'sent') {
      const sent = viewerContext.data;
      replyTo(sent.to_address || '', sent.subject || '', sent.body_text || '', sent.sent_at || '');
      return;
    }

    if (viewerContext.type === 'email') {
      const email = viewerContext.data;
      replyTo(email.from_address || '', email.subject || '', email.body_text || '', email.received_at || '');
    }
  }

  function forwardFromViewer() {
    if (!viewerContext) return;

    if (viewerContext.type === 'sent') {
      const sent = viewerContext.data;
      forwardEmail(sent.subject || '', sent.body_text || '', sent.sent_at || '', sent.to_address || '');
      return;
    }

    if (viewerContext.type === 'email') {
      const email = viewerContext.data;
      forwardEmail(email.subject || '', email.body_text || '', email.received_at || '', email.from_address || '');
    }
  }

  function replyTo(addr, subject, originalText, timestamp) {
    openCompose();
    activeDraftId = null;
    renderComposeTag();

    const toInput = byId('composeTo');
    const subjectInput = byId('composeSubject');
    const bodyInput = byId('composeBody');

    if (toInput) toInput.value = String(addr || '');
    if (subjectInput) subjectInput.value = addSubjectPrefix(subject, 'Re');
    if (bodyInput) {
      bodyInput.value = quotedBlock('From', addr, timestamp, originalText || '');
      bodyInput.focus();
      bodyInput.setSelectionRange(0, 0);
    }

    setSendStatus('', false);
  }

  function forwardEmail(subject, originalText, timestamp, originalFrom) {
    openCompose();
    activeDraftId = null;
    renderComposeTag();

    const toInput = byId('composeTo');
    const subjectInput = byId('composeSubject');
    const bodyInput = byId('composeBody');

    if (toInput) {
      toInput.value = '';
      toInput.focus();
    }
    if (subjectInput) subjectInput.value = addSubjectPrefix(subject, 'Fwd');
    if (bodyInput) {
      bodyInput.value = quotedBlock('Forwarded from', originalFrom, timestamp, originalText || '');
    }

    setSendStatus('', false);
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const comma = result.indexOf(',');
        resolve(comma === -1 ? result : result.slice(comma + 1));
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  async function doSend() {
    const toInput = byId('composeTo');
    const subjectInput = byId('composeSubject');
    const bodyInput = byId('composeBody');
    const filesInput = byId('composeFiles');

    const to = toInput ? String(toInput.value || '').trim() : '';
    const subject = subjectInput ? String(subjectInput.value || '').trim() : '';
    const text = bodyInput ? String(bodyInput.value || '').trim() : '';
    const from = selectedFromAddress();

    const files = filesInput && filesInput.files ? Array.from(filesInput.files) : [];
    const attachments = [];

    if (files.length > 0) {
      setSendStatus('Preparing attachments...', false);
      try {
        for (const file of files) {
          const base64 = await fileToBase64(file);
          attachments.push({
            filename: file.name || 'attachment',
            mimeType: file.type || 'application/octet-stream',
            content: base64,
          });
        }
      } catch {
        setSendStatus('Error: Failed to read attachments', true);
        return;
      }
    }

    setSendStatus('Sending...', false);
    const payload = { to, subject, text, attachments };
    if (from) {
      payload.from = from;
    }

    const res = await apiFetch('/api/send', 'POST', payload);

    if (res.status === 401) {
      logout();
      return;
    }

    if (res.ok) {
      if (activeDraftId) {
        removeDraftById(activeDraftId);
        if (selectedDraftId === activeDraftId) {
          selectedDraftId = null;
        }
      }

      activeDraftId = null;
      clearComposeFields();
      renderComposeTag();
      setSendStatus('Sent!', false);

      if (currentFolder === 'sent' || currentFolder === 'drafts') {
        loadFolder(currentFolder === 'drafts' ? 'drafts' : 'sent');
      }

      setTimeout(() => {
        closeCompose(true);
        setSendStatus('', false);
      }, 1000);

      return;
    }

    const data = await res.json().catch(() => ({ error: 'Failed to send' }));
    setSendStatus('Error: ' + (data.error || 'Failed to send'), true);
  }

  function apiFetch(path, method = 'GET', body = null, extraHeaders = null) {
    const headers = {};

    if (TOKEN) {
      headers.Authorization = 'Bearer ' + TOKEN;
    }

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    if (extraHeaders && typeof extraHeaders === 'object') {
      Object.assign(headers, extraHeaders);
    }

    return fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function doLogin() {
    const userInput = byId('loginUser');
    const passInput = byId('loginPass');
    const loginError = byId('loginError');

    const username = userInput ? String(userInput.value || '').trim() : '';
    const password = passInput ? String(passInput.value || '') : '';

    const res = await apiFetch('/api/login', 'POST', { username, password });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (loginError) {
        loginError.textContent = data.error || 'Login failed';
      }
      return;
    }

    TOKEN = String(data.token || '');
    if (loginError) {
      loginError.textContent = '';
    }

    setSenderAddressesFromPayload(data);

    showApp();
  }

  async function logout() {
    try {
      await apiFetch('/api/logout', 'POST');
    } catch {
      // Ignore network errors and force client-side sign-out state.
    }

    TOKEN = '';
    selectedEmailId = null;
    selectedDraftId = null;
    viewerContext = null;
    setSenderAddressesFromPayload({});
    showLogin();
  }

  function showLogin() {
    const login = byId('login');
    const app = byId('app');
    if (login) login.style.display = 'flex';
    if (app) app.style.display = 'none';
  }

  function showApp() {
    const login = byId('login');
    const app = byId('app');
    if (login) login.style.display = 'none';
    if (app) app.style.display = 'flex';

    renderDraftCount();
    loadFolder('inbox');
  }

  async function bootstrapSession() {
    renderDraftCount();
    const res = await apiFetch('/api/me');
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      setSenderAddressesFromPayload(data);
      showApp();
      return;
    }

    setSenderAddressesFromPayload({});
    showLogin();
  }

  function bindUiEvents() {
    const loginForm = byId('loginForm');
    if (loginForm) {
      loginForm.addEventListener('submit', (event) => {
        event.preventDefault();
        doLogin();
      });
    }

    document.querySelectorAll('.folder-btn[data-folder]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const folder = btn.getAttribute('data-folder') || 'inbox';
        loadFolder(folder, btn);
      });
    });

    const composeOpenBtn = byId('composeOpenBtn');
    if (composeOpenBtn) {
      composeOpenBtn.addEventListener('click', () => {
        beginNewCompose();
      });
    }

    const closeComposeBtn = byId('closeComposeBtn');
    if (closeComposeBtn) {
      closeComposeBtn.addEventListener('click', () => {
        closeCompose(false);
      });
    }

    const saveDraftBtn = byId('saveDraftBtn');
    if (saveDraftBtn) {
      saveDraftBtn.addEventListener('click', () => {
        saveDraft(true);
      });
    }

    const discardDraftBtn = byId('discardDraftBtn');
    if (discardDraftBtn) {
      discardDraftBtn.addEventListener('click', () => {
        discardDraft();
      });
    }

    const logoutBtn = byId('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        logout();
      });
    }

    const sendBtn = byId('sendBtn');
    if (sendBtn) {
      sendBtn.addEventListener('click', () => {
        doSend();
      });
    }

    const composeFrom = byId('composeFrom');
    if (composeFrom) {
      composeFrom.addEventListener('change', () => {
        selectedFromAddress();
      });
    }

    const listSearch = byId('listSearch');
    if (listSearch) {
      listSearch.addEventListener('input', () => {
        renderList();
      });
    }

    const list = byId('list');
    if (list) {
      list.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const row = target.closest('.email-row[data-row-id][data-row-type]');
        if (!row) return;

        const rowId = String(row.getAttribute('data-row-id') || '');
        const rowType = String(row.getAttribute('data-row-type') || '');

        if (rowType === 'draft') {
          openDraftFromList(rowId);
          return;
        }

        const emailId = Number(rowId);
        if (Number.isFinite(emailId) && emailId > 0) {
          loadEmail(emailId);
        }
      });
    }

    const viewer = byId('viewer');
    if (viewer) {
      viewer.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const actionBtn = target.closest('[data-action]');
        if (!actionBtn) return;

        const action = String(actionBtn.getAttribute('data-action') || '');
        if (action === 'download-attachment') {
          const attachmentId = Number(actionBtn.getAttribute('data-attachment-id'));
          if (Number.isFinite(attachmentId) && attachmentId > 0) {
            downloadAttachment(attachmentId);
          }
          return;
        }

        if (action === 'reply') {
          replyFromViewer();
          return;
        }

        if (action === 'forward') {
          forwardFromViewer();
          return;
        }

        if (!viewerContext || !viewerContext.data) {
          return;
        }

        if (action === 'delete-email') {
          moveEmailToTrash(Number(viewerContext.data.id));
          return;
        }

        if (action === 'delete-forever') {
          deleteEmailForever(Number(viewerContext.data.id));
          return;
        }

        if (action === 'restore-email') {
          restoreEmailFromTrash(Number(viewerContext.data.id));
          return;
        }

        if (action === 'delete-sent') {
          deleteSentEmail(Number(viewerContext.data.id));
          return;
        }

        if (action === 'edit-draft') {
          editDraft(String(viewerContext.data.id || ''));
          return;
        }

        if (action === 'delete-draft') {
          deleteDraftFromViewer(String(viewerContext.data.id || ''));
        }
      });
    }

    const composeInputs = ['composeTo', 'composeSubject', 'composeBody'];
    for (const inputId of composeInputs) {
      const input = byId(inputId);
      if (input) {
        input.addEventListener('input', () => {
          scheduleDraftAutosave();
        });
      }
    }

    const mobileBackBtn = byId('mobileBackBtn');
    if (mobileBackBtn) {
      mobileBackBtn.addEventListener('click', () => {
        setMobilePane('list');
      });
    }

    window.addEventListener('resize', () => {
      syncMobilePaneFromSelection();
    });
  }

  bindUiEvents();
  bootstrapSession();
</script>
</body>
</html>`;
}
