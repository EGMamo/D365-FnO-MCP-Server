/**
 * The key-administration page served at `GET /admin`: one static document, inline style and script carrying the
 * response's nonce, no external resource. The admin key stays in a variable of the page (never in storage or the
 * URL), and every value from the server is written with textContent, never as HTML.
 */
export function renderAdminPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Developer keys</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 52rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  section { margin: 1.5rem 0; }
  input { font: inherit; padding: .35rem .5rem; min-width: 18rem; }
  button { font: inherit; padding: .35rem .8rem; cursor: pointer; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid #8884; }
  code, .secret { font-family: ui-monospace, monospace; word-break: break-all; }
  .secret { display: block; padding: .6rem; border: 1px solid #8886; border-radius: 4px; margin: .4rem 0; }
  .note { opacity: .75; }
  .error { color: #c62828; }
  [hidden] { display: none; }
</style>
</head>
<body>
<h1>Developer keys</h1>
<section id="unlock">
  <label for="admin-key">Admin key</label><br>
  <input id="admin-key" type="password" autocomplete="off" spellcheck="false">
  <button id="open">Open</button>
  <p class="note">The admin key stays in this page only. It is sent with each request and never stored.</p>
</section>
<p id="message" role="status"></p>
<section id="manage" hidden>
  <h2>New key</h2>
  <input id="name" placeholder="Developer name, for example alice" autocomplete="off" spellcheck="false">
  <button id="create">New key</button>
  <div id="created" hidden>
    <p><strong>Copy this key now. It is not shown again.</strong></p>
    <span id="created-key" class="secret"></span>
    <button id="copy">Copy</button>
    <p>The developer runs: <code id="command"></code> and pastes the key when asked.</p>
  </div>
  <h2>Keys</h2>
  <table>
    <thead><tr><th>Name</th><th>Created</th><th></th></tr></thead>
    <tbody id="keys"></tbody>
  </table>
</section>
<script nonce="${nonce}">
(() => {
  let adminKey = '';
  const $ = (id) => document.getElementById(id);
  const say = (text, isError) => { $('message').textContent = text; $('message').className = isError ? 'error' : ''; };
  const call = async (method, path, body) => {
    const res = await fetch('/admin/api' + path, {
      method,
      headers: Object.assign({ 'X-Admin-Key': adminKey }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      credentials: 'omit',
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  };
  const render = (keys) => {
    const body = $('keys');
    body.replaceChildren();
    for (const key of keys) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = key.name;
      const created = document.createElement('td');
      created.textContent = key.source === 'settings' ? 'managed outside the server' : new Date(key.createdAt).toLocaleString();
      const action = document.createElement('td');
      if (key.source === 'registry') {
        const revoke = document.createElement('button');
        revoke.textContent = 'Revoke';
        revoke.addEventListener('click', async () => {
          if (!confirm('Revoke the key of ' + key.name + '? Its sessions end at once.')) return;
          try { await call('DELETE', '/keys/' + encodeURIComponent(key.name)); say('Revoked ' + key.name + '.'); await load(); }
          catch (error) { say(error.message, true); }
        });
        action.append(revoke);
      }
      row.append(name, created, action);
      body.append(row);
    }
  };
  const load = async () => { render((await call('GET', '/keys')).keys); };
  $('open').addEventListener('click', async () => {
    adminKey = $('admin-key').value.trim();
    $('admin-key').value = '';
    try { await load(); $('unlock').hidden = true; $('manage').hidden = false; say(''); }
    catch (error) { adminKey = ''; say(error.message, true); }
  });
  $('create').addEventListener('click', async () => {
    const name = $('name').value.trim();
    try {
      const made = await call('POST', '/keys', { name });
      $('created-key').textContent = made.key;
      $('command').textContent = 'd365-fno-mcp setup --mode hosted --hosted-url ' + location.origin + '/mcp';
      $('created').hidden = false;
      $('name').value = '';
      say('Created a key for ' + made.name + '.');
      await load();
    } catch (error) { say(error.message, true); }
  });
  $('copy').addEventListener('click', () => { void navigator.clipboard.writeText($('created-key').textContent); say('Copied.'); });
})();
</script>
</body>
</html>
`;
}
