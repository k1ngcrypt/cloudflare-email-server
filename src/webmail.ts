export function getWebmailHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Webmail</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; display: flex; height: 100vh; overflow: hidden; background: #f3f4f6; }

    #sidebar  { width: 220px; background: #1e293b; color: #e2e8f0; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
    #list     { width: 340px; background: #fff; border-right: 1px solid #e5e7eb; overflow-y: auto; }
    #viewer   { flex: 1; padding: 24px; overflow-y: auto; background: #fff; }
    #compose  { display: none; position: fixed; bottom: 0; right: 24px; width: min(480px, calc(100vw - 32px)); background: #fff; border: 1px solid #e5e7eb; border-radius: 8px 8px 0 0; box-shadow: 0 -4px 16px rgba(0,0,0,0.1); z-index: 100; }

    #login    { display: flex; align-items: center; justify-content: center; height: 100vh; width: 100vw; position: fixed; top: 0; left: 0; background: #f3f4f6; z-index: 200; }
    .login-box { background: #fff; padding: 32px; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); width: 320px; display: flex; flex-direction: column; gap: 12px; }

    .folder-btn { background: none; border: none; color: #94a3b8; padding: 8px 12px; border-radius: 6px; cursor: pointer; text-align: left; font-size: 14px; }
    .folder-btn.active, .folder-btn:hover { background: #334155; color: #f1f5f9; }

    .email-row { padding: 12px 16px; border-bottom: 1px solid #f1f5f9; cursor: pointer; }
    .email-row:hover { background: #f8fafc; }
    .email-row.unread .email-from { font-weight: 700; }
    .email-from { font-size: 13px; color: #1e293b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .email-subject { font-size: 12px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .email-date { font-size: 11px; color: #94a3b8; }

    .viewer-header { border-bottom: 1px solid #e5e7eb; padding-bottom: 16px; margin-bottom: 16px; }
    .viewer-subject { font-size: 20px; font-weight: 600; color: #1e293b; }
    .viewer-meta { font-size: 13px; color: #64748b; margin-top: 4px; }
    .viewer-body { font-size: 14px; color: #374151; line-height: 1.6; white-space: pre-wrap; }

    .compose-header { background: #1e293b; color: #f1f5f9; padding: 10px 14px; border-radius: 8px 8px 0 0; display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
    .compose-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .compose-body input, .compose-body textarea { width: 100%; padding: 8px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 13px; font-family: inherit; }
    .compose-body textarea { min-height: 120px; resize: vertical; }

    .btn { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .btn-primary:hover { background: #2563eb; }
    .btn-danger  { background: #ef4444; color: #fff; }
    input[type=text], input[type=password] { width: 100%; padding: 10px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 14px; }

    @media (max-width: 900px) {
      body { flex-direction: column; overflow: auto; height: auto; min-height: 100vh; }
      #sidebar { width: 100%; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 6px; }
      #list { width: 100%; border-right: none; border-top: 1px solid #e5e7eb; max-height: 260px; }
      #viewer { width: 100%; }
    }
  </style>
</head>
<body>

<div id="login">
  <div class="login-box">
    <h2 style="font-size:20px;font-weight:700;color:#1e293b;">Webmail Login</h2>
    <input id="loginUser" type="text" placeholder="Username" />
    <input id="loginPass" type="password" placeholder="Password" />
    <button class="btn btn-primary" onclick="doLogin()">Sign In</button>
    <div id="loginError" style="color:#ef4444;font-size:13px;"></div>
  </div>
</div>

<div id="app" style="display:none;width:100%;flex-direction:row;">
  <div id="sidebar">
    <div style="font-weight:700;font-size:16px;margin-bottom:12px;color:#f1f5f9;">Webmail</div>
    <button class="folder-btn active" data-folder="inbox" onclick="loadFolder('inbox', this)">Inbox</button>
    <button class="folder-btn" data-folder="sent" onclick="loadFolder('sent', this)">Sent</button>
    <button class="folder-btn" data-folder="trash" onclick="loadFolder('trash', this)">Trash</button>
    <div style="flex:1;"></div>
    <button class="btn btn-primary" onclick="openCompose()" style="width:100%;">Compose</button>
    <button class="folder-btn" onclick="logout()" style="margin-top:8px;">Sign Out</button>
  </div>

  <div id="list"><div style="padding:16px;color:#94a3b8;font-size:13px;">Loading...</div></div>

  <div id="viewer"><div style="color:#94a3b8;padding:24px;">Select an email to read it.</div></div>
</div>

<div id="compose">
  <div class="compose-header" onclick="toggleCompose()">
    <span>New Message</span>
    <span id="closeCompose" style="cursor:pointer;">x</span>
  </div>
  <div class="compose-body">
    <input id="composeTo" type="text" placeholder="To" />
    <input id="composeSubject" type="text" placeholder="Subject" />
    <textarea id="composeBody" placeholder="Write your message..."></textarea>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-primary" onclick="doSend()">Send</button>
      <div id="sendStatus" style="font-size:12px;color:#64748b;align-self:center;"></div>
    </div>
  </div>
</div>

<script>
  let TOKEN = localStorage.getItem('webmail_token') || '';
  let currentFolder = 'inbox';

  function addSubjectPrefix(subject, prefix) {
    const s = String(subject || '').trim();
    const p = prefix + ': ';
    return s.toLowerCase().startsWith(p.toLowerCase()) ? s : (p + s);
  }

  function quotedBlock(metaLabel, addr, timestamp, bodyText) {
    const intro = '\n\n--- Original message ---\n';
    const when = timestamp ? new Date(timestamp).toLocaleString() : '';
    const header = metaLabel + ': ' + String(addr || '') + (when ? ('\nDate: ' + when) : '') + '\n\n';
    const content = String(bodyText || '(empty)')
      .split('\n')
      .map((line) => '> ' + line)
      .join('\n');
    return intro + header + content;
  }

  async function doLogin() {
    const user = document.getElementById('loginUser').value;
    const pass = document.getElementById('loginPass').value;
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
    });
    const data = await res.json();
    if (!res.ok) {
      document.getElementById('loginError').textContent = data.error || 'Login failed';
      return;
    }
    TOKEN = data.token;
    localStorage.setItem('webmail_token', TOKEN);
    showApp();
  }

  function logout() {
    TOKEN = '';
    localStorage.removeItem('webmail_token');
    document.getElementById('login').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
  }

  function showApp() {
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    loadFolder('inbox');
  }

  if (TOKEN) {
    showApp();
  }

  async function loadFolder(folder, btn) {
    currentFolder = folder;
    document.querySelectorAll('.folder-btn[data-folder]').forEach((b) => b.classList.remove('active'));
    if (btn) {
      btn.classList.add('active');
    } else {
      const activeBtn = document.querySelector('.folder-btn[data-folder="' + folder + '"]');
      if (activeBtn) activeBtn.classList.add('active');
    }

    const endpoint = folder === 'sent' ? '/api/sent' : '/api/emails?folder=' + encodeURIComponent(folder);
    const res = await apiFetch(endpoint);

    if (res.status === 401) {
      logout();
      return;
    }

    const emails = await res.json();
    renderList(Array.isArray(emails) ? emails : []);
  }

  function renderList(emails) {
    const list = document.getElementById('list');
    if (!emails.length) {
      list.innerHTML = '<div style="padding:16px;color:#94a3b8;font-size:13px;">No emails here.</div>';
      return;
    }

    list.innerHTML = emails.map((e) => {
      const senderOrRecipient = currentFolder === 'sent'
        ? ('To: ' + esc(e.to_address || ''))
        : esc(e.from_name || e.from_address || '');
      const ts = e.received_at || e.sent_at || new Date().toISOString();
      const unreadClass = e.read ? '' : 'unread';

      return '\n        <div class="email-row ' + unreadClass + '" onclick="loadEmail(' + Number(e.id) + ')">\n          <div class="email-from">' + senderOrRecipient + '</div>\n          <div class="email-subject">' + esc(e.subject || '(no subject)') + '</div>\n          <div class="email-date">' + new Date(ts).toLocaleString() + '</div>\n        </div>\n      ';
    }).join('');
  }

  async function loadEmail(id) {
    if (currentFolder === 'sent') {
      const res = await apiFetch('/api/sent/' + id);
      if (!res.ok) {
        document.getElementById('viewer').innerHTML = '<div style="color:#ef4444;padding:24px;">Failed to load sent message.</div>';
        return;
      }

      const sent = await res.json();
      const sentDate = sent.sent_at ? new Date(sent.sent_at).toLocaleString() : '(unknown)';
      document.getElementById('viewer').innerHTML = '\n        <div class="viewer-header">\n          <div class="viewer-subject">' + esc(sent.subject || '(no subject)') + '</div>\n          <div class="viewer-meta">\n            To: ' + esc(sent.to_address || '') + '<br>\n            Date: ' + esc(sentDate) + '\n          </div>\n          <div style="margin-top:8px;display:flex;gap:8px;">\n            <button class="btn btn-primary" onclick="replyTo(' + JSON.stringify(sent.to_address || '') + ', ' + JSON.stringify(sent.subject || '') + ', ' + JSON.stringify(sent.body_text || '') + ', ' + JSON.stringify(sent.sent_at || '') + ')">Reply</button>\n            <button class="btn btn-primary" onclick="forwardEmail(' + JSON.stringify(sent.subject || '') + ', ' + JSON.stringify(sent.body_text || '') + ', ' + JSON.stringify(sent.sent_at || '') + ', ' + JSON.stringify(sent.to_address || '') + ')">Forward</button>\n          </div>\n        </div>\n        <div class="viewer-body">' + renderBody(sent) + '</div>\n      ';
      return;
    }

    const res = await apiFetch('/api/emails/' + id);
    if (!res.ok) {
      document.getElementById('viewer').innerHTML = '<div style="color:#ef4444;padding:24px;">Failed to load message.</div>';
      return;
    }

    const email = await res.json();
    const safeFrom = esc(email.from_name ? (email.from_name + ' <' + email.from_address + '>') : email.from_address);

    document.getElementById('viewer').innerHTML = '\n      <div class="viewer-header">\n        <div class="viewer-subject">' + esc(email.subject || '(no subject)') + '</div>\n        <div class="viewer-meta">\n          From: ' + safeFrom + '<br>\n          To: ' + esc(email.to_address) + '<br>\n          Date: ' + new Date(email.received_at).toLocaleString() + '\n        </div>\n        <div style="margin-top:8px;display:flex;gap:8px;">\n          <button class="btn btn-primary" onclick="replyTo(' + JSON.stringify(email.from_address || '') + ', ' + JSON.stringify(email.subject || '') + ', ' + JSON.stringify(email.body_text || '') + ', ' + JSON.stringify(email.received_at || '') + ')">Reply</button>\n          <button class="btn btn-primary" onclick="forwardEmail(' + JSON.stringify(email.subject || '') + ', ' + JSON.stringify(email.body_text || '') + ', ' + JSON.stringify(email.received_at || '') + ', ' + JSON.stringify(email.from_address || '') + ')">Forward</button>\n          <button class="btn btn-danger" onclick="deleteEmail(' + Number(email.id) + ')">Delete</button>\n        </div>\n      </div>\n      <div class="viewer-body">' + renderBody(email) + '</div>\n    ';

    document.querySelectorAll('.email-row').forEach((r) => {
      if ((r.getAttribute('onclick') || '').includes('loadEmail(' + Number(email.id) + ')')) {
        r.classList.remove('unread');
      }
    });
  }

  function renderBody(email) {
    if (email.body_html) {
      const srcdoc = String(email.body_html).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return '<iframe sandbox="" srcdoc="' + srcdoc + '" style="width:100%;min-height:400px;border:none;"></iframe>';
    }
    return esc(email.body_text || '(empty)');
  }

  async function deleteEmail(id) {
    await apiFetch('/api/emails/' + id, 'DELETE');
    await loadFolder(currentFolder);
    document.getElementById('viewer').innerHTML = '<div style="color:#94a3b8;padding:24px;">Email deleted.</div>';
  }

  function openCompose() {
    document.getElementById('compose').style.display = 'block';
  }

  function toggleCompose() {
    const c = document.getElementById('compose');
    c.style.display = c.style.display === 'none' ? 'block' : 'none';
  }

  function replyTo(addr, subject, originalText, timestamp) {
    document.getElementById('composeTo').value = addr;
    document.getElementById('composeSubject').value = addSubjectPrefix(subject, 'Re');
    document.getElementById('composeBody').value = quotedBlock('From', addr, timestamp, originalText || '');
    document.getElementById('composeBody').focus();
    document.getElementById('composeBody').setSelectionRange(0, 0);
    openCompose();
  }

  function forwardEmail(subject, originalText, timestamp, originalFrom) {
    document.getElementById('composeTo').value = '';
    document.getElementById('composeSubject').value = addSubjectPrefix(subject, 'Fwd');
    document.getElementById('composeBody').value = quotedBlock('Forwarded from', originalFrom, timestamp, originalText || '');
    document.getElementById('composeTo').focus();
    openCompose();
  }

  async function doSend() {
    const to = document.getElementById('composeTo').value;
    const subject = document.getElementById('composeSubject').value;
    const text = document.getElementById('composeBody').value;
    const status = document.getElementById('sendStatus');

    status.textContent = 'Sending...';

    const res = await apiFetch('/api/send', 'POST', { to, subject, text });
    if (res.ok) {
      status.textContent = 'Sent!';
      document.getElementById('composeTo').value = '';
      document.getElementById('composeSubject').value = '';
      document.getElementById('composeBody').value = '';
      setTimeout(() => {
        document.getElementById('compose').style.display = 'none';
      }, 1200);
      if (currentFolder === 'sent') {
        loadFolder('sent');
      }
    } else {
      const data = await res.json().catch(() => ({ error: 'Failed to send' }));
      status.textContent = 'Error: ' + (data.error || 'Failed to send');
    }
  }

  function apiFetch(path, method = 'GET', body = null) {
    const headers = {
      Authorization: 'Bearer ' + TOKEN,
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    return fetch(path, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
</script>
</body>
</html>`;
}
