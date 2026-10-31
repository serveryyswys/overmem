/* OverMem plugin runtime console (vanilla JS, no build step). */
(() => {
  const TOKEN_KEY = 'overmem_token';
  const LOGIN_URL = '/admin/login.html';
  const state = { mode: 'ubuntu', token: localStorage.getItem(TOKEN_KEY) || '' };

  const $ = (id) => document.getElementById(id);
  const toast = (msg, isErr) => {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '');
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2600);
  };

  function logout() {
    state.token = '';
    localStorage.removeItem(TOKEN_KEY);
    location.replace(LOGIN_URL);
  }

  async function api(path, options = {}) {
    const opts = Object.assign({ headers: {} }, options);
    if (state.token) opts.headers.Authorization = 'Bearer ' + state.token;
    if (opts.body && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      if (res.status === 401) {
        logout();
        throw new Error('登录已过期，请重新登录');
      }
      const detail = data && (data.detail || (data.error && data.error.message)) || res.statusText;
      throw new Error(detail || ('HTTP ' + res.status));
    }
    return data;
  }

  /* ---------- health ---------- */
  async function refreshHealth() {
    try {
      const data = await api('/health');
      if (data.mode) state.mode = data.mode;
      $('status-dot').className = 'status ok';
      $('status-text').textContent = '运行中';
      $('subtitle').textContent = 'v' + data.version + ' · ' + data.plugins_count + ' 个插件 · ' + state.mode + ' 模式';
      $('footer-meta').textContent = 'v' + data.version + ' · ' + state.mode;
    } catch (e) {
      $('status-dot').className = 'status err';
      $('status-text').textContent = '不可用';
      $('subtitle').textContent = String(e.message || e);
    }
  }

  /* ---------- tabs ---------- */
  let activeTab = 'overview';
  function switchTab(name) {
    activeTab = name;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    ['overview', 'plugins', 'keys', 'logs'].forEach((n) => { $('tab-' + n).hidden = n !== name; });
    if (name === 'overview') loadOverview();
    if (name === 'plugins') loadPlugins();
    if (name === 'keys') loadKeys();
    if (name === 'logs') loadLogs();
  }

  /* ---------- overview ---------- */
  async function loadOverview() {
    const cards = $('overview-cards');
    try {
      const [health, plugins] = await Promise.all([api('/health'), api('/v1/plugins')]);
      state.mode = plugins.mode || state.mode;
      cards.innerHTML =
        card('版本', health.version) +
        card('插件', String(health.plugins_count)) +
        card('模式', plugins.mode) +
        card('能力', String((plugins.plugins || []).reduce((n, p) => n + (p.capabilities || []).length, 0)));
      $('subtitle').textContent = 'v' + health.version + ' · ' + health.plugins_count + ' 个插件 · ' + plugins.mode + ' 模式';
      renderLogs($('overview-logs'), (await api('/v1/logs?limit=10')).logs || []);
    } catch (e) {
      cards.innerHTML = '';
      toast('概览加载失败: ' + e.message, true);
    }
  }
  const card = (k, v) => '<div class="card"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';

  /* ---------- plugins ---------- */
  async function loadPlugins() {
    const tbody = $('plugins-table').querySelector('tbody');
    const select = $('config-plugin');
    const filter = $('log-filter');
    try {
      const data = await api('/v1/plugins');
      state.mode = data.mode || state.mode;
      const list = data.plugins || [];
      tbody.innerHTML = list.map((p) => {
        const badge = '<span class="badge ' + esc(p.status) + '">' + esc(p.status) + '</span>';
        const caps = (p.capabilities || []).map((c) => '<div>' + esc(c) + '</div>').join('');
        const actions = [
          '<button data-act="toggle" data-id="' + esc(p.id) + '" data-enabled="' + (p.status !== 'disabled') + '">' + (p.status === 'disabled' ? '启用' : '停用') + '</button>',
          '<button data-act="reload" data-id="' + esc(p.id) + '">重载</button>',
          '<button class="danger" data-act="delete" data-id="' + esc(p.id) + '">卸载</button>',
        ].join(' ');
        return '<tr><td>' + esc(p.id) + '</td><td>' + esc(p.name) + '</td><td>' + esc(p.version) + '</td>' +
          '<td>' + badge + (p.error ? '<div class="muted">' + esc(p.error) + '</div>' : '') + '</td>' +
          '<td>' + (caps || '<span class="muted">-</span>') + '</td><td>' + actions + '</td></tr>';
      }).join('') || '<tr><td colspan="6" class="muted">暂无插件</td></tr>';

      select.innerHTML = list.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.name + ' (' + p.id + ')') + '</option>').join('');
      filter.innerHTML = '<option value="">全部插件</option>' +
        list.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
    } catch (e) { toast('插件列表失败: ' + e.message, true); }
  }

  $('plugins-table').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    try {
      if (btn.dataset.act === 'toggle') {
        const enabled = btn.dataset.enabled !== 'true';
        await api('/v1/plugins/' + encodeURIComponent(id) + '/enable', { method: 'POST', body: { enabled } });
        toast(enabled ? '已启用 ' + id : '已停用 ' + id);
      } else if (btn.dataset.act === 'reload') {
        await api('/v1/plugins/' + encodeURIComponent(id) + '/reload', { method: 'POST' });
        toast('已重载 ' + id);
      } else if (btn.dataset.act === 'delete') {
        if (!confirm('确认卸载 ' + id + '？')) return;
        await api('/v1/plugins/' + encodeURIComponent(id), { method: 'DELETE' });
        toast('已卸载 ' + id);
      }
      loadPlugins();
    } catch (e) { toast(e.message, true); }
  });

  $('zip-input').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    try {
      await api('/v1/plugins/install', { method: 'POST', body: form });
      toast('安装成功: ' + file.name);
      loadPlugins();
    } catch (e) { toast('安装失败: ' + e.message, true); }
    ev.target.value = '';
  });
  $('refresh-plugins').addEventListener('click', loadPlugins);

  $('load-config').addEventListener('click', async () => {
    const id = $('config-plugin').value;
    const form = $('config-form');
    if (!id) { form.textContent = '暂无插件'; return; }
    try {
      const data = await api('/v1/plugins');
      const plugin = (data.plugins || []).find((p) => p.id === id);
      if (!plugin) { form.textContent = '插件不存在'; return; }
      renderConfigForm(plugin.schema || plugin.config_schema || [], plugin.config || {});
    } catch (e) { toast('配置读取失败: ' + e.message, true); }
  });

  function renderConfigForm(schema, values) {
    const form = $('config-form');
    if (!schema.length) { form.textContent = '该插件没有可配置项'; return; }
    form.innerHTML = schema.map((item) => {
      const v = values[item.name] !== undefined ? values[item.name] : (item.default !== undefined ? item.default : '');
      const label = '<label for="cfg-' + esc(item.name) + '">' + esc(item.name) + '</label>';
      let input;
      if (Array.isArray(item.enum)) {
        input = '<select id="cfg-' + esc(item.name) + '" data-name="' + esc(item.name) + '" data-type="' + esc(item.type || 'string') + '">' +
          item.enum.map((o) => '<option value="' + esc(o) + '"' + (String(o) === String(v) ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
      } else {
        const type = item.type === 'int' || item.type === 'float' ? 'number' : (item.type === 'bool' ? 'checkbox' : 'text');
        const checked = type === 'checkbox' && (v === true || v === 'true') ? ' checked' : '';
        const val = type === 'checkbox' ? '' : ' value="' + esc(v) + '"';
        input = '<input id="cfg-' + esc(item.name) + '" data-name="' + esc(item.name) + '" data-type="' + esc(item.type || 'string') + '" type="' + type + '"' + val + checked + ' />';
      }
      return '<div class="field">' + label + input + (item.description ? '<span class="muted">' + esc(item.description) + '</span>' : '') + '</div>';
    }).join('') + '<div class="row"><button id="save-config" class="primary">保存配置</button></div>';
    $('save-config').addEventListener('click', () => saveConfig($('config-plugin').value));
  }

  async function saveConfig(id) {
    const values = {};
    document.querySelectorAll('#config-form [data-name]').forEach((el) => {
      const name = el.dataset.name;
      const type = el.dataset.type;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (type === 'int') v = parseInt(v, 10);
      if (type === 'float') v = parseFloat(v);
      values[name] = v;
    });
    try {
      await api('/v1/plugins/' + encodeURIComponent(id) + '/config', { method: 'PUT', body: { values } });
      toast('配置已保存（重载后生效）');
    } catch (e) { toast('保存失败: ' + e.message, true); }
  }

  /* ---------- keys ---------- */
  async function loadKeys() {
    if (state.mode !== 'docker') return;
    const tbody = $('keys-table').querySelector('tbody');
    try {
      const data = await api('/v1/keys');
      tbody.innerHTML = (data.keys || []).map((k) =>
        '<tr><td>' + esc(k.id) + '</td><td>' + esc(k.label || '') + '</td><td>' + esc((k.scopes || []).join(', ')) + '</td>' +
        '<td>' + esc(k.created_at || '') + '</td><td>' + esc(k.last_used_at || '-') + '</td>' +
        '<td><button class="danger" data-key="' + esc(k.id) + '">吊销</button></td></tr>'
      ).join('') || '<tr><td colspan="6" class="muted">暂无 API Key</td></tr>';
    } catch (e) { toast('Key 列表失败: ' + e.message, true); }
  }

  $('key-create').addEventListener('click', async () => {
    const scopes = $('key-scopes').value.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const data = await api('/v1/keys', { method: 'POST', body: { label: $('key-label').value, scopes } });
      const out = $('key-output');
      out.hidden = false;
      out.textContent = '已创建 ' + data.key.id + '：\n' + data.key.key + '\n（请立即保存，仅显示一次）';
      loadKeys();
    } catch (e) { toast('创建失败: ' + e.message, true); }
  });

  $('keys-table').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-key]');
    if (!btn) return;
    if (!confirm('吊销该 Key？')) return;
    try {
      await api('/v1/keys/' + encodeURIComponent(btn.dataset.key), { method: 'DELETE' });
      toast('已吊销');
      loadKeys();
    } catch (e) { toast(e.message, true); }
  });

  /* ---------- logs ---------- */
  async function loadLogs() {
    const plugin = $('log-filter').value;
    try {
      const q = '/v1/logs?limit=200' + (plugin ? '&plugin=' + encodeURIComponent(plugin) : '');
      renderLogs($('logbox'), (await api(q)).logs || []);
    } catch (e) { toast('日志加载失败: ' + e.message, true); }
  }
  $('refresh-logs').addEventListener('click', loadLogs);

  function renderLogs(container, logs) {
    container.innerHTML = logs.map((l) =>
      '<div class="logline"><span class="lvl ' + esc(l.level) + '">' + esc(l.level) + '</span>' +
      '<span class="ts">' + esc(l.time || '') + '</span><span>' + esc(l.message || '') + '</span></div>'
    ).join('') || '<span class="muted">暂无日志</span>';
  }

  /* ---------- user menu ---------- */
  function syncUserMenu() {
    const docker = state.mode === 'docker';
    const keyTab = document.querySelector('.tab[data-tab="keys"]');
    if (keyTab) keyTab.hidden = !docker;
    $('user-state').textContent = docker ? '已登录' : '本地模式';
    $('relogin').hidden = !docker;
    $('logout').hidden = !docker;
  }

  $('user-btn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    $('user-dropdown').classList.toggle('open');
  });
  document.addEventListener('click', () => $('user-dropdown').classList.remove('open'));
  $('logout').addEventListener('click', logout);

  function esc(v) {
    return String(v === undefined || v === null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  (async () => {
    try {
      const res = await fetch('/health', { headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (data.mode) state.mode = data.mode;
    } catch (e) { /* keep defaults */ }
    if (state.mode === 'docker' && !state.token) {
      location.replace(LOGIN_URL);
      return;
    }
    syncUserMenu();
    await refreshHealth();
    syncUserMenu();
    switchTab('overview');
    setInterval(refreshHealth, 15000);
  })();
})();
