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
    .attachment-list { margin-top: 16px; border-top: 1px solid #e5e7eb; padding-top: 12px; display: flex; flex-direction: column; gap: 8px; }
    .attachment-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 8px; background: #f8fafc; }
    .attachment-meta { min-width: 0; }
    .attachment-name { font-size: 13px; color: #0f172a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .attachment-size { font-size: 11px; color: #64748b; }

    .compose-header { background: #1e293b; color: #f1f5f9; padding: 10px 14px; border-radius: 8px 8px 0 0; display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
    .compose-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .compose-body input, .compose-body textarea { width: 100%; padding: 8px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 13px; font-family: inherit; }
    .compose-body textarea { min-height: 120px; resize: vertical; }
    .compose-file-hint { font-size: 11px; color: #64748b; }

    .btn { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .btn-primary:hover { background: #2563eb; }
    .btn-danger  { background: #ef4444; color: #fff; }
    .btn-secondary { background: #e2e8f0; color: #0f172a; }
    .btn-secondary:hover { background: #cbd5e1; }
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
    <input id="composeFiles" type="file" multiple />
    <div class="compose-file-hint">Attach up to 10 files, max 20 MB total.</div>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-primary" onclick="doSend()">Send</button>
      <div id="sendStatus" style="font-size:12px;color:#64748b;align-self:center;"></div>
    </div>
  </div>
</div>

<script>
  let TOKEN = '';
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
    const res = await apiFetch('/api/login', 'POST', { username: user, password: pass });
    const data = await res.json();
    if (!res.ok) {
      document.getElementById('loginError').textContent = data.error || 'Login failed';
      return;
    }
    TOKEN = String(data.token || '');
    document.getElementById('loginError').textContent = '';
    showApp();
  }

  async function logout() {
    try {
      await apiFetch('/api/logout', 'POST');
    } catch {
      // Ignore network errors and force client-side sign-out state.
    }

    TOKEN = '';
    showLogin();
  }

  function showLogin() {
    document.getElementById('login').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
  }

  function showApp() {
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    loadFolder('inbox');
  }

  async function bootstrapSession() {
    const res = await apiFetch('/api/me');
    if (res.ok) {
      showApp();
      return;
    }

    showLogin();
  }

  bootstrapSession();

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
      document.getElementById('viewer').innerHTML = '\n        <div class="viewer-header">\n          <div class="viewer-subject">' + esc(sent.subject || '(no subject)') + '</div>\n          <div class="viewer-meta">\n            To: ' + esc(sent.to_address || '') + '<br>\n            Date: ' + esc(sentDate) + '\n          </div>\n          <div style="margin-top:8px;display:flex;gap:8px;">\n            <button class="btn btn-primary" id="replySentBtn">Reply</button>\n            <button class="btn btn-primary" id="forwardSentBtn">Forward</button>\n          </div>\n        </div>\n        <div class="viewer-body">' + renderBody(sent) + '</div>\n        ' + renderAttachments(sent.attachments || []) + '\n      ';

      const replySentBtn = document.getElementById('replySentBtn');
      if (replySentBtn) {
        replySentBtn.addEventListener('click', () => {
          replyTo(sent.to_address || '', sent.subject || '', sent.body_text || '', sent.sent_at || '');
        });
      }

      const forwardSentBtn = document.getElementById('forwardSentBtn');
      if (forwardSentBtn) {
        forwardSentBtn.addEventListener('click', () => {
          forwardEmail(sent.subject || '', sent.body_text || '', sent.sent_at || '', sent.to_address || '');
        });
      }

      return;
    }

    const res = await apiFetch('/api/emails/' + id);
    if (!res.ok) {
      document.getElementById('viewer').innerHTML = '<div style="color:#ef4444;padding:24px;">Failed to load message.</div>';
      return;
    }

    const email = await res.json();
    const safeFrom = esc(email.from_name ? (email.from_name + ' <' + email.from_address + '>') : email.from_address);

    document.getElementById('viewer').innerHTML = '\n      <div class="viewer-header">\n        <div class="viewer-subject">' + esc(email.subject || '(no subject)') + '</div>\n        <div class="viewer-meta">\n          From: ' + safeFrom + '<br>\n          To: ' + esc(email.to_address) + '<br>\n          Date: ' + new Date(email.received_at).toLocaleString() + '\n        </div>\n        <div style="margin-top:8px;display:flex;gap:8px;">\n          <button class="btn btn-primary" id="replyInboxBtn">Reply</button>\n          <button class="btn btn-primary" id="forwardInboxBtn">Forward</button>\n          <button class="btn btn-danger" id="deleteInboxBtn">Delete</button>\n        </div>\n      </div>\n      <div class="viewer-body">' + renderBody(email) + '</div>\n      ' + renderAttachments(email.attachments || []) + '\n    ';

    const replyInboxBtn = document.getElementById('replyInboxBtn');
    if (replyInboxBtn) {
      replyInboxBtn.addEventListener('click', () => {
        replyTo(email.from_address || '', email.subject || '', email.body_text || '', email.received_at || '');
      });
    }

    const forwardInboxBtn = document.getElementById('forwardInboxBtn');
    if (forwardInboxBtn) {
      forwardInboxBtn.addEventListener('click', () => {
        forwardEmail(email.subject || '', email.body_text || '', email.received_at || '', email.from_address || '');
      });
    }

    const deleteInboxBtn = document.getElementById('deleteInboxBtn');
    if (deleteInboxBtn) {
      deleteInboxBtn.addEventListener('click', () => {
        deleteEmail(Number(email.id));
      });
    }

    document.querySelectorAll('.email-row').forEach((r) => {
      if ((r.getAttribute('onclick') || '').includes('loadEmail(' + Number(email.id) + ')')) {
        r.classList.remove('unread');
      }
    });
  }

  function renderBody(email) {
    if (email.body_html) {
      const srcdoc = String(email.body_html).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return '<iframe sandbox="" referrerpolicy="no-referrer" srcdoc="' + srcdoc + '" style="width:100%;min-height:400px;border:none;"></iframe>';
    }
    return esc(email.body_text || '(empty)');
  }

  function renderAttachments(attachments) {
    if (!Array.isArray(attachments) || !attachments.length) {
      return '';
    }

    return '<div class="attachment-list"><div style="font-size:12px;font-weight:600;color:#334155;">Attachments</div>' + attachments.map((attachment) => {
      const id = Number(attachment.id);
      const filename = String(attachment.filename || 'attachment');
      const size = formatBytes(Number(attachment.size_bytes || 0));
      return '<div class="attachment-item"><div class="attachment-meta"><div class="attachment-name">' + esc(filename) + '</div><div class="attachment-size">' + esc(size) + '</div></div><button class="btn btn-secondary" onclick="downloadAttachment(' + id + ')">Download</button></div>';
    }).join('') + '</div>';
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

  async function downloadAttachment(id) {
    const res = await apiFetch('/api/attachments/' + Number(id) + '/download');
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
    const filesInput = document.getElementById('composeFiles');
    const status = document.getElementById('sendStatus');

    const files = filesInput && filesInput.files ? Array.from(filesInput.files) : [];
    const attachments = [];

    if (files.length > 0) {
      status.textContent = 'Preparing attachments...';
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
        status.textContent = 'Error: Failed to read attachments';
        return;
      }
    }

    status.textContent = 'Sending...';

    const res = await apiFetch('/api/send', 'POST', { to, subject, text, attachments });
    if (res.ok) {
      status.textContent = 'Sent!';
      document.getElementById('composeTo').value = '';
      document.getElementById('composeSubject').value = '';
      document.getElementById('composeBody').value = '';
      if (filesInput) filesInput.value = '';
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

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  // Expose inline onclick handlers on the global window object
  // so inline attributes like onclick="doLogin()" resolve.
  Object.assign(window, {
    doLogin,
    logout,
    loadFolder,
    openCompose,
    toggleCompose,
    doSend,
    loadEmail,
    downloadAttachment,
  });
</script>
</body>
</html>`;
}
