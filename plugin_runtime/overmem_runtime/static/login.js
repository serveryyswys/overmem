/* OverMem runtime console — login page (vanilla JS, no build step). */
(() => {
  const TOKEN_KEY = 'overmem_token';
  const $ = (id) => document.getElementById(id);

  function showError(msg) {
    const box = $('login-error');
    box.textContent = msg;
    box.hidden = false;
  }

  async function health() {
    try {
      const res = await fetch('/health', { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  async function boot() {
    const data = await health();
    if (data) {
      $('login-foot').textContent = 'OverMem Plugin Runtime · v' + data.version + ' · ' + data.mode;
      if (data.mode !== 'docker') {
        location.replace('/admin/');
        return;
      }
    }
    $('api-key').focus();
  }

  async function submit(ev) {
    ev.preventDefault();
    const btn = $('login-btn');
    const raw = $('api-key').value.trim();
    $('login-error').hidden = true;
    if (!raw) {
      showError('请输入 API Key。');
      return;
    }
    btn.disabled = true;
    btn.textContent = '登录中…';
    let token = raw;
    // A raw JWT can be used directly; an API Key is exchanged for a token.
    if (raw.split('.').length !== 3) {
      try {
        const res = await fetch('/v1/auth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ api_key: raw }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          const detail = (data && (data.detail || (data.error && data.error.message))) || ('HTTP ' + res.status);
          showError(String(detail));
          btn.disabled = false;
          btn.textContent = '登录';
          return;
        }
        token = data && data.token;
        if (!token) {
          showError('服务端未返回令牌。');
          btn.disabled = false;
          btn.textContent = '登录';
          return;
        }
      } catch (e) {
        showError('无法连接运行时：' + (e.message || e));
        btn.disabled = false;
        btn.textContent = '登录';
        return;
      }
    }
    localStorage.setItem(TOKEN_KEY, token);
    location.replace('/admin/');
  }

  $('login-form').addEventListener('submit', submit);
  boot();
})();
