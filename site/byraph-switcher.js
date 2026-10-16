/* byraph internal app switcher: a small menu for hopping between byraph's internal tools.
 *
 * ONE file, copied unchanged into every site (hub, comp tool, Demand Desk, batch tool, store admin);
 * keep the copies identical, like the hub's sso.mjs. The original lives in byraph-hub/public/.
 * No dependencies. It draws inside a shadow root, so no site's CSS can reach it and it cannot
 * reach any site's CSS.
 *
 * Use, once per page:
 *   <script src="byraph-switcher.js" data-app="comps" defer></script>
 * data-app is the current app (batch | comps | demand | admin | hub), marked "here" in the menu.
 *
 * The button sits in the SAME place on every site, so flipping between them is one click in one
 * spot (Eli, 2026-10-15): 12px from the top and left of the window, 32px square, pinned there
 * (position: fixed) so it is always reachable, also on the store admin whose bar hides and comes
 * back on scroll. Each site keeps that corner clear at all times: nothing in the top 56px x 56px
 * while at the top of the page. Content scrolling underneath passes under the button.
 * Older pages that mark the app with a <div data-byraph-switcher="demand"> slot still work; the
 * slot only names the app now and takes no space.
 *
 * Links go through the hub (internal.byraph.com/go/<tool>), so the one hub login carries over; the
 * store admin keeps its own login at byraph.com/admin.
 */
(() => {
  if (window.byraphSwitcher) return window.byraphSwitcher.mount();
  const SCRIPT = document.currentScript;
  const currentApp = () =>
    SCRIPT?.dataset.app || document.querySelector('[data-byraph-switcher]')?.getAttribute('data-byraph-switcher') || '';

  const HUB = 'https://internal.byraph.com';
  const svg = (paths) =>
    `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const APPS = [
    { id: 'batch', name: 'Batch tool', blurb: 'SKU batches, names and photos', href: `${HUB}/go/batch`, tint: '#2563eb',
      icon: svg('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>') },
    { id: 'comps', name: 'Comp tool', blurb: 'Comps and pricing', href: `${HUB}/go/comps`, tint: '#15803d',
      icon: svg('<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>') },
    { id: 'demand', name: 'Demand Desk', blurb: 'Deal finder and market alerts', href: `${HUB}/go/demand`, tint: '#7c3aed',
      icon: svg('<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>') },
    { id: 'admin', name: 'byraph admin', blurb: 'Orders, stock, customers', href: 'https://byraph.com/admin', tint: '#f26b1d',
      icon: '<img alt="" width="22" height="22" src="data:image/png;base64,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">' },
  ];
  const GRID = svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>');

  const CSS = `
    :host { all: initial; position: fixed; top: 12px; left: 12px; z-index: 2147483000; display: block;
      font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; }
    button.trigger { all: unset; box-sizing: border-box; width: 32px; height: 32px; display: grid; place-items: center;
      border-radius: 8px; color: #444; background: rgba(255,255,255,.9); border: 1px solid rgba(0,0,0,.12); cursor: pointer; }
    button.trigger:hover, button.trigger[aria-expanded="true"] { color: #111; background: #fff; border-color: rgba(0,0,0,.25); }
    button.trigger:focus-visible, a:focus-visible { outline: 2px solid #f26b1d; outline-offset: 2px; }
    .menu { position: absolute; top: calc(100% + 6px); left: 0; width: 268px; box-sizing: border-box; padding: 6px;
      background: #fff; border: 1px solid rgba(0,0,0,.12); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.16); }
    .menu[hidden] { display: none; }
    .title { padding: 6px 8px 4px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #777; }
    a { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 8px;
      cursor: pointer; color: #111; }
    a:hover { background: #f3f3f1; }
    a[aria-current="page"] { background: #f6f6f4; cursor: default; }
    .tile { flex: none; width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; color: var(--tint);
      background: color-mix(in srgb, var(--tint) 12%, #fff); }
    .tile img { display: block; border-radius: 5px; }
    .name { font-weight: 600; font-size: 13px; }
    .blurb { color: #777; font-size: 12px; }
    .here { margin-left: auto; font-size: 11px; color: #777; }
    .foot { display: block; margin-top: 4px; padding: 8px 8px 4px; border-top: 1px solid #eee; font-size: 12px; color: #777; }
    .foot:hover { background: none; color: #111; text-decoration: underline; }
  `;

  function build(host, current) {
    const root = host.attachShadow({ mode: 'open' });
    const items = APPS.map(
      (a) => `<a href="${a.href}" role="menuitem" style="--tint:${a.tint}"${a.id === current ? ' aria-current="page"' : ''}>
        <span class="tile">${a.icon}</span>
        <span><span class="name">${a.name}</span><br><span class="blurb">${a.blurb}</span></span>
        ${a.id === current ? '<span class="here">here</span>' : ''}</a>`
    ).join('');
    root.innerHTML = `<style>${CSS}</style>
      <button class="trigger" type="button" aria-haspopup="menu" aria-expanded="false" title="byraph internal tools">${GRID}</button>
      <div class="menu" role="menu" hidden>
        <div class="title">byraph internal</div>${items}
        <a class="foot" href="${HUB}/" role="menuitem">All tools · internal.byraph.com</a>
      </div>`;
    const btn = root.querySelector('.trigger');
    const menu = root.querySelector('.menu');
    const open = (on) => {
      menu.hidden = !on;
      btn.setAttribute('aria-expanded', String(on));
      if (on) root.querySelector('a:not([aria-current])')?.focus();
    };
    btn.addEventListener('click', (e) => (e.stopPropagation(), open(menu.hidden)));
    // the current app's row does nothing; the others navigate in the same tab
    root.querySelectorAll('a[aria-current]').forEach((a) => a.addEventListener('click', (e) => (e.preventDefault(), open(false))));
    document.addEventListener('click', (e) => !e.composedPath().includes(host) && open(false));
    document.addEventListener('keydown', (e) => {
      if (menu.hidden) return;
      if (e.key === 'Escape') (open(false), btn.focus());
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const links = [...root.querySelectorAll('a')];
        const i = links.indexOf(root.activeElement);
        links[(i + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length].focus();
        e.preventDefault();
      }
    });
  }

  function mount() {
    if (document.getElementById('byraph-switcher')) return;
    const host = document.createElement('div');
    host.id = 'byraph-switcher';
    document.body.appendChild(host);
    build(host, currentApp());
  }

  window.byraphSwitcher = { mount };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', mount) : mount();
})();
