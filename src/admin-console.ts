export function getAdminConsoleHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Webmail Admin Console</title>
  <style>
    * { box-sizing: border-box; }

    :root {
      --bg-a: #f4f8ff;
      --bg-b: #e9f2ff;
      --surface: #ffffff;
      --surface-2: #f6fbff;
      --text: #0f2438;
      --muted: #5f768d;
      --border: #d6e3f0;
      --brand: #0b74c4;
      --brand-strong: #095f9f;
      --danger: #d93a3a;
      --ok: #0f8a46;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI Variable", "Segoe UI", "Trebuchet MS", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at 8% 14%, #ffffff 0%, #ffffff70 26%, transparent 56%),
        radial-gradient(circle at 94% 8%, #d9f0ff 0%, #d9f0ff6b 33%, transparent 61%),
        linear-gradient(180deg, var(--bg-b), var(--bg-a));
    }

    .login-wrap {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(244, 248, 255, 0.94);
      backdrop-filter: blur(4px);
      z-index: 50;
    }

    .login-card {
      width: min(370px, calc(100vw - 28px));
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--surface);
      box-shadow: 0 16px 36px rgba(15, 36, 56, 0.15);
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .login-card h2 {
      margin: 0;
      font-size: 24px;
      letter-spacing: 0.2px;
    }

    .hint {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }

    .shell {
      display: none;
      min-height: 100vh;
      padding: 14px;
      gap: 12px;
      grid-template-rows: auto 1fr;
    }

    .topbar {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--surface);
      box-shadow: 0 10px 26px rgba(15, 36, 56, 0.1);
      padding: 12px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .brand {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .brand h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.1;
      letter-spacing: 0.2px;
    }

    .brand p {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(290px, 370px) minmax(0, 1fr);
      gap: 12px;
      min-height: 0;
    }

    .panel {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--surface);
      box-shadow: 0 10px 24px rgba(15, 36, 56, 0.08);
      overflow: hidden;
    }

    .panel-head {
      border-bottom: 1px solid var(--border);
      padding: 12px 14px;
      background: var(--surface-2);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .panel-title {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.2px;
    }

    .panel-body {
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    label {
      font-size: 12px;
      font-weight: 600;
      color: #26445f;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    input,
    select,
    textarea {
      width: 100%;
      border: 1px solid #cfddeb;
      border-radius: 8px;
      padding: 9px;
      font-size: 13px;
      font-family: inherit;
      color: var(--text);
      background: #fff;
    }

    textarea {
      min-height: 84px;
      resize: vertical;
    }

    input:focus,
    select:focus,
    textarea:focus {
      outline: 2px solid #bfe4ff;
      outline-offset: 1px;
      border-color: #7fc6f8;
    }

    .small-note {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }

    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .btn {
      border: 0;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      padding: 8px 12px;
      transition: filter 0.15s ease;
    }

    .btn:hover {
      filter: brightness(0.96);
    }

    .btn-brand {
      color: #fff;
      background: linear-gradient(180deg, #1697f2, var(--brand));
    }

    .btn-soft {
      color: #14314c;
      background: #e4edf6;
    }

    .btn-danger {
      color: #fff;
      background: linear-gradient(180deg, #ef5555, var(--danger));
    }

    .status {
      min-height: 20px;
      font-size: 13px;
      color: var(--muted);
    }

    .status.error { color: var(--danger); }
    .status.ok { color: var(--ok); }

    .table-wrap {
      overflow: auto;
      max-height: calc(100vh - 190px);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 720px;
    }

    th,
    td {
      text-align: left;
      border-bottom: 1px solid #e5edf5;
      padding: 10px;
      font-size: 13px;
      vertical-align: top;
    }

    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: #f3f8fd;
      color: #21415d;
      font-size: 12px;
      letter-spacing: 0.2px;
    }

    .role-pill {
      display: inline-flex;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      border: 1px solid #b8d5eb;
      background: #e7f4ff;
      color: #0e4f80;
    }

    .role-pill.user {
      border-color: #d3dde8;
      background: #f2f6fa;
      color: #415f79;
    }

    .table-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .empty-state {
      padding: 20px;
      font-size: 13px;
      color: var(--muted);
    }

    .forbidden {
      display: none;
      max-width: 640px;
      margin: 40px auto;
      border: 1px solid #f0c7c7;
      border-radius: 12px;
      background: #fff4f4;
      color: #8c2a2a;
      padding: 18px;
      line-height: 1.5;
    }

    @media (max-width: 980px) {
      .layout {
        grid-template-columns: 1fr;
      }

      .table-wrap {
        max-height: none;
      }
    }
  </style>
</head>
<body>
  <div id="loginWrap" class="login-wrap">
    <div class="login-card">
      <h2>Admin Login</h2>
      <div class="hint">Sign in with an account that has admin role.</div>
      <form id="loginForm" style="display:flex;flex-direction:column;gap:10px;">
        <input id="loginUser" type="text" placeholder="Username" autocomplete="username" />
        <input id="loginPass" type="password" placeholder="Password" autocomplete="current-password" />
        <button type="submit" class="btn btn-brand">Sign In</button>
      </form>
      <div id="loginStatus" class="status"></div>
    </div>
  </div>

  <div id="forbidden" class="forbidden">
    <strong>Admin role required.</strong>
    <div>This account is authenticated but does not have access to this console.</div>
    <div style="margin-top:10px;">
      <a href="/">Return to webmail</a>
    </div>
  </div>

  <main id="shell" class="shell">
    <section class="topbar">
      <div class="brand">
        <h1>User Administration</h1>
        <p id="whoami">Loading session...</p>
      </div>
      <div class="toolbar">
        <button id="refreshBtn" class="btn btn-soft" type="button">Refresh</button>
        <button id="goWebmailBtn" class="btn btn-soft" type="button">Webmail</button>
        <button id="logoutBtn" class="btn btn-danger" type="button">Sign Out</button>
      </div>
    </section>

    <section class="layout">
      <article class="panel">
        <div class="panel-head">
          <div id="formTitle" class="panel-title">Create User</div>
          <button id="cancelEditBtn" class="btn btn-soft" type="button" style="display:none;">Cancel Edit</button>
        </div>
        <div class="panel-body">
          <form id="userForm" style="display:flex;flex-direction:column;gap:10px;">
            <label>
              Username
              <input id="username" type="text" maxlength="120" required />
            </label>

            <label>
              Role
              <select id="role" required>
                <option value="admin">admin</option>
                <option value="user">user</option>
              </select>
            </label>

            <label>
              Primary Email Address
              <input id="primaryEmail" type="email" required />
            </label>

            <label>
              Alias Emails
              <textarea id="aliasEmails" placeholder="One email per line, or comma-separated"></textarea>
            </label>

            <label>
              Password
              <input id="password" type="password" />
            </label>

            <div class="small-note" id="passwordHint">Password is required for new users.</div>

            <div class="row">
              <button id="submitBtn" class="btn btn-brand" type="submit">Create User</button>
            </div>
          </form>

          <div id="formStatus" class="status"></div>
        </div>
      </article>

      <article class="panel">
        <div class="panel-head">
          <div class="panel-title">Users</div>
          <div class="small-note">Changes update both D1 users and OCI approved senders.</div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Username</th>
                <th>Role</th>
                <th>Primary</th>
                <th>Emails</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="usersBody"></tbody>
          </table>
          <div id="tableEmpty" class="empty-state" style="display:none;">No users found.</div>
        </div>
      </article>
    </section>
  </main>

  <script>
    let currentUser = null;
    let users = [];
    let editingUserId = null;

    function byId(id) {
      return document.getElementById(id);
    }

    function esc(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function setStatus(id, message, tone) {
      const el = byId(id);
      if (!el) return;
      el.textContent = String(message || '');
      el.className = 'status' + (tone ? ' ' + tone : '');
    }

    function splitAliasEmails(raw) {
      return String(raw || '')
        .split(/[\n,;]/)
        .map((part) => String(part || '').trim().toLowerCase())
        .filter((part) => part.length > 0);
    }

    async function apiFetch(path, method, body) {
      return fetch(path, {
        method: method || 'GET',
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    }

    function showLogin() {
      const login = byId('loginWrap');
      const shell = byId('shell');
      const forbidden = byId('forbidden');
      if (login) login.style.display = 'flex';
      if (shell) shell.style.display = 'none';
      if (forbidden) forbidden.style.display = 'none';
    }

    function showForbidden() {
      const login = byId('loginWrap');
      const shell = byId('shell');
      const forbidden = byId('forbidden');
      if (login) login.style.display = 'none';
      if (shell) shell.style.display = 'none';
      if (forbidden) forbidden.style.display = 'block';
    }

    function showShell() {
      const login = byId('loginWrap');
      const shell = byId('shell');
      const forbidden = byId('forbidden');
      if (login) login.style.display = 'none';
      if (shell) shell.style.display = 'grid';
      if (forbidden) forbidden.style.display = 'none';
    }

    function setEditMode(user) {
      const isEditing = Boolean(user);
      editingUserId = isEditing ? Number(user.id) : null;

      const formTitle = byId('formTitle');
      const submitBtn = byId('submitBtn');
      const cancelEditBtn = byId('cancelEditBtn');
      const passwordHint = byId('passwordHint');
      const passwordInput = byId('password');

      if (formTitle) formTitle.textContent = isEditing ? 'Edit User #' + user.id : 'Create User';
      if (submitBtn) submitBtn.textContent = isEditing ? 'Save Changes' : 'Create User';
      if (cancelEditBtn) cancelEditBtn.style.display = isEditing ? 'inline-block' : 'none';
      if (passwordHint) {
        passwordHint.textContent = isEditing
          ? 'Password is optional when editing. Leave blank to keep existing password.'
          : 'Password is required for new users.';
      }

      if (!isEditing) {
        const form = byId('userForm');
        if (form) form.reset();
        setStatus('formStatus', '', '');
        return;
      }

      const username = byId('username');
      const role = byId('role');
      const primaryEmail = byId('primaryEmail');
      const aliasEmails = byId('aliasEmails');

      if (username) username.value = String(user.username || '');
      if (role) role.value = String(user.role || 'user');
      if (primaryEmail) primaryEmail.value = String(user.primaryEmail || '');

      const aliases = Array.isArray(user.emails)
        ? user.emails.filter((email) => String(email || '').toLowerCase() !== String(user.primaryEmail || '').toLowerCase())
        : [];

      if (aliasEmails) aliasEmails.value = aliases.join('\n');
      if (passwordInput) passwordInput.value = '';
      setStatus('formStatus', '', '');
    }

    function renderUsers() {
      const body = byId('usersBody');
      const empty = byId('tableEmpty');
      if (!body || !empty) return;

      if (!Array.isArray(users) || users.length === 0) {
        body.innerHTML = '';
        empty.style.display = 'block';
        return;
      }

      empty.style.display = 'none';
      body.innerHTML = users.map((user) => {
        const emails = Array.isArray(user.emails) ? user.emails : [];
        const createdAt = user.createdAt ? new Date(user.createdAt).toLocaleString() : '';
        const roleClass = String(user.role || '').toLowerCase() === 'admin' ? 'role-pill' : 'role-pill user';

        return '<tr>' +
          '<td>' + esc(user.id) + '</td>' +
          '<td>' + esc(user.username) + '</td>' +
          '<td><span class="' + roleClass + '">' + esc(user.role) + '</span></td>' +
          '<td>' + esc(user.primaryEmail) + '</td>' +
          '<td>' + esc(emails.join(', ')) + '</td>' +
          '<td>' + esc(createdAt) + '</td>' +
          '<td><div class="table-actions">' +
            '<button type="button" class="btn btn-soft" data-action="edit" data-id="' + esc(user.id) + '">Edit</button>' +
            '<button type="button" class="btn btn-danger" data-action="delete" data-id="' + esc(user.id) + '">Delete</button>' +
          '</div></td>' +
        '</tr>';
      }).join('');
    }

    async function loadUsers() {
      setStatus('formStatus', 'Loading users...', '');
      const response = await apiFetch('/api/admin/users', 'GET');

      if (response.status === 401) {
        showLogin();
        setStatus('formStatus', '', '');
        return;
      }

      if (response.status === 403) {
        showForbidden();
        setStatus('formStatus', '', '');
        return;
      }

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setStatus('formStatus', payload.error || 'Failed to load users', 'error');
        return;
      }

      users = await response.json().catch(() => []);
      renderUsers();
      setStatus('formStatus', '', '');
    }

    function getFormPayload() {
      const username = byId('username');
      const role = byId('role');
      const primaryEmail = byId('primaryEmail');
      const aliasEmails = byId('aliasEmails');
      const password = byId('password');

      const payload = {
        username: username ? String(username.value || '').trim() : '',
        role: role ? String(role.value || 'user') : 'user',
        primaryEmail: primaryEmail ? String(primaryEmail.value || '').trim().toLowerCase() : '',
        emails: splitAliasEmails(aliasEmails ? aliasEmails.value : ''),
      };

      const passwordValue = password ? String(password.value || '') : '';
      if (passwordValue.length > 0) {
        payload.password = passwordValue;
      }

      return payload;
    }

    async function createOrUpdateUser(event) {
      event.preventDefault();
      const payload = getFormPayload();

      if (!payload.username || !payload.primaryEmail) {
        setStatus('formStatus', 'Username and primary email are required.', 'error');
        return;
      }

      if (!editingUserId && !payload.password) {
        setStatus('formStatus', 'Password is required for new users.', 'error');
        return;
      }

      setStatus('formStatus', editingUserId ? 'Saving user...' : 'Creating user...', '');

      const endpoint = editingUserId ? '/api/admin/users/' + editingUserId : '/api/admin/users';
      const method = editingUserId ? 'PUT' : 'POST';
      const response = await apiFetch(endpoint, method, payload);

      if (response.status === 401) {
        showLogin();
        return;
      }

      if (response.status === 403) {
        showForbidden();
        return;
      }

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStatus('formStatus', result.error || 'User operation failed.', 'error');
        return;
      }

      setStatus('formStatus', editingUserId ? 'User updated successfully.' : 'User created successfully.', 'ok');
      setEditMode(null);
      await loadUsers();
    }

    async function deleteUser(userId) {
      const target = users.find((user) => Number(user.id) === Number(userId));
      const label = target ? String(target.username) : 'this user';

      if (!window.confirm('Delete ' + label + '? This removes the account and its approved senders.')) {
        return;
      }

      setStatus('formStatus', 'Deleting user...', '');
      const response = await apiFetch('/api/admin/users/' + Number(userId), 'DELETE');

      if (response.status === 401) {
        showLogin();
        return;
      }

      if (response.status === 403) {
        showForbidden();
        return;
      }

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStatus('formStatus', result.error || 'Failed to delete user.', 'error');
        return;
      }

      if (editingUserId === Number(userId)) {
        setEditMode(null);
      }

      setStatus('formStatus', 'User deleted.', 'ok');
      await loadUsers();
    }

    async function selectUserForEdit(userId) {
      const user = users.find((entry) => Number(entry.id) === Number(userId));
      if (!user) {
        setStatus('formStatus', 'User not found in current list.', 'error');
        return;
      }

      setEditMode(user);
    }

    async function doLogin(event) {
      event.preventDefault();
      const userInput = byId('loginUser');
      const passInput = byId('loginPass');
      const username = userInput ? String(userInput.value || '').trim() : '';
      const password = passInput ? String(passInput.value || '') : '';

      setStatus('loginStatus', 'Signing in...', '');

      const response = await apiFetch('/api/login', 'POST', { username, password });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        setStatus('loginStatus', result.error || 'Login failed.', 'error');
        return;
      }

      setStatus('loginStatus', '', '');
      await bootstrapSession();
    }

    async function doLogout() {
      await apiFetch('/api/logout', 'POST');
      currentUser = null;
      users = [];
      editingUserId = null;
      setEditMode(null);
      showLogin();
    }

    async function bootstrapSession() {
      const meResponse = await apiFetch('/api/me', 'GET');

      if (meResponse.status === 401) {
        showLogin();
        return;
      }

      const me = await meResponse.json().catch(() => ({}));
      if (!meResponse.ok) {
        showLogin();
        return;
      }

      currentUser = me;

      if (String(me.role || '').toLowerCase() !== 'admin') {
        showForbidden();
        return;
      }

      const whoami = byId('whoami');
      if (whoami) {
        whoami.textContent = 'Signed in as ' + String(me.username || 'unknown') + ' (' + String(me.email || 'no-email') + ')';
      }

      setEditMode(null);
      showShell();
      await loadUsers();
    }

    function bindEvents() {
      const loginForm = byId('loginForm');
      if (loginForm) {
        loginForm.addEventListener('submit', doLogin);
      }

      const userForm = byId('userForm');
      if (userForm) {
        userForm.addEventListener('submit', createOrUpdateUser);
      }

      const cancelEditBtn = byId('cancelEditBtn');
      if (cancelEditBtn) {
        cancelEditBtn.addEventListener('click', () => {
          setEditMode(null);
        });
      }

      const logoutBtn = byId('logoutBtn');
      if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
          doLogout();
        });
      }

      const refreshBtn = byId('refreshBtn');
      if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
          loadUsers();
        });
      }

      const goWebmailBtn = byId('goWebmailBtn');
      if (goWebmailBtn) {
        goWebmailBtn.addEventListener('click', () => {
          window.location.href = '/';
        });
      }

      const usersBody = byId('usersBody');
      if (usersBody) {
        usersBody.addEventListener('click', (event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;

          const button = target.closest('button[data-action][data-id]');
          if (!button) return;

          const action = String(button.getAttribute('data-action') || '');
          const userId = Number(button.getAttribute('data-id'));
          if (!Number.isFinite(userId) || userId <= 0) return;

          if (action === 'edit') {
            selectUserForEdit(userId);
            return;
          }

          if (action === 'delete') {
            deleteUser(userId);
          }
        });
      }
    }

    bindEvents();
    bootstrapSession();
  </script>
</body>
</html>`;
}
