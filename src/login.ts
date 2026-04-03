export function getLoginHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Webmail Login</title>
  <style>
    * { box-sizing: border-box; }

    :root {
      --bg-a: #f4f8ff;
      --bg-b: #e7f2ff;
      --surface: #ffffff;
      --text: #10243a;
      --muted: #5c7289;
      --border: #d2e1ef;
      --brand-a: #1292ea;
      --brand-b: #0b73c2;
      --danger: #d33a3a;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 18px;
      color: var(--text);
      font-family: "Segoe UI Variable", "Segoe UI", "Trebuchet MS", sans-serif;
      background:
        radial-gradient(circle at 8% 12%, #ffffff 0%, #ffffff66 26%, transparent 56%),
        radial-gradient(circle at 92% 8%, #d9f0ff 0%, #d9f0ff5e 33%, transparent 60%),
        linear-gradient(180deg, var(--bg-b), var(--bg-a));
    }

    .card {
      width: min(390px, 100%);
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--surface);
      box-shadow: 0 18px 40px rgba(15, 36, 56, 0.14);
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    h1 {
      margin: 0;
      font-size: 24px;
      letter-spacing: 0.2px;
    }

    .subtitle {
      margin: 0;
      font-size: 13px;
      line-height: 1.5;
      color: var(--muted);
    }

    form {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 4px;
    }

    input {
      width: 100%;
      border: 1px solid #ccdbea;
      border-radius: 8px;
      padding: 10px;
      font-size: 14px;
      color: var(--text);
      background: #fff;
      font-family: inherit;
    }

    input:focus {
      outline: 2px solid #bae1ff;
      outline-offset: 1px;
      border-color: #7fc5f8;
    }

    button {
      border: 0;
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 14px;
      font-weight: 700;
      color: #fff;
      cursor: pointer;
      background: linear-gradient(180deg, var(--brand-a), var(--brand-b));
    }

    button:disabled {
      opacity: 0.75;
      cursor: default;
    }

    .status {
      min-height: 20px;
      font-size: 13px;
      color: var(--danger);
    }

    .footnote {
      font-size: 12px;
      color: var(--muted);
    }

    .route-chip {
      display: inline-flex;
      border-radius: 999px;
      border: 1px solid #c6d8e9;
      background: #edf5fd;
      color: #244663;
      font-size: 11px;
      padding: 2px 8px;
      margin-left: 4px;
      vertical-align: middle;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Unified Login</h1>
    <p class="subtitle">
      Sign in once to access your mailbox and admin tools.
      Mailbox route:
      <span class="route-chip">/mail</span>
    </p>

    <form id="loginForm">
      <input id="username" type="text" placeholder="Username" autocomplete="username" required />
      <input id="password" type="password" placeholder="Password" autocomplete="current-password" required />
      <button id="loginButton" type="submit">Sign In</button>
    </form>

    <div id="status" class="status"></div>
    <div class="footnote">Admins can continue to <strong>/admin</strong> after signing in.</div>
  </main>

  <script>
    function byId(id) {
      return document.getElementById(id);
    }

    async function apiFetch(path, method = 'GET', body = null) {
      const headers = {};
      if (body) {
        headers['Content-Type'] = 'application/json';
      }

      return fetch(path, {
        method,
        headers,
        credentials: 'same-origin',
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    }

    function setStatus(message) {
      const status = byId('status');
      if (!status) return;
      status.textContent = message;
    }

    async function bootstrap() {
      const response = await apiFetch('/api/me');
      if (response.ok) {
        window.location.href = '/mail';
      }
    }

    async function handleLogin(event) {
      event.preventDefault();

      const usernameInput = byId('username');
      const passwordInput = byId('password');
      const loginButton = byId('loginButton');

      const username = usernameInput ? String(usernameInput.value || '').trim() : '';
      const password = passwordInput ? String(passwordInput.value || '') : '';

      if (!username || !password) {
        setStatus('Username and password are required.');
        return;
      }

      if (loginButton) {
        loginButton.disabled = true;
      }
      setStatus('Signing in...');

      try {
        const response = await apiFetch('/api/login', 'POST', { username, password });
        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
          setStatus(result.error || 'Login failed.');
          return;
        }

        setStatus('');
        window.location.href = '/mail';
      } catch {
        setStatus('Unable to reach the server. Try again.');
      } finally {
        if (loginButton) {
          loginButton.disabled = false;
        }
      }
    }

    const loginForm = byId('loginForm');
    if (loginForm) {
      loginForm.addEventListener('submit', handleLogin);
    }

    bootstrap();
  </script>
</body>
</html>`;
}
