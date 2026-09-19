import { api, el, clear, initials, toast } from './core.js';
import { icon } from './icons.js';
import { renderLogin } from './views/login.js';
import { renderDashboard } from './views/dashboard.js';
import { renderDomains } from './views/domains.js';
import { renderDomainManage } from './views/domain-manage.js';
import { renderUsers } from './views/users.js';
import { renderProviders } from './views/providers.js';
import { renderResources } from './views/resources.js';
import { renderEmails } from './views/emails.js';
import { renderProfile } from './views/profile.js';

const root = document.getElementById('app');

export const state = { user: null };

// --- Navigation ------------------------------------------------------------

const ADMIN_NAV = [
  { route: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { route: 'domains', label: 'Domains', icon: 'globe' },
  { route: 'users', label: 'Users', icon: 'users' },
  { route: 'providers', label: 'Providers / APIs', icon: 'plug' },
  { route: 'resources', label: 'Server Resources', icon: 'server' },
  { route: 'settings', label: 'Settings', icon: 'settings' },
];

const USER_NAV = [
  { route: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { route: 'domains', label: 'My Domains', icon: 'globe' },
  { route: 'emails', label: 'Emails', icon: 'mail' },
  { route: 'resources', label: 'Resources', icon: 'server' },
  { route: 'settings', label: 'Profile', icon: 'settings' },
];

const VIEWS = {
  dashboard: renderDashboard,
  domains: renderDomains,
  domain: renderDomainManage,
  users: renderUsers,
  providers: renderProviders,
  resources: renderResources,
  emails: renderEmails,
  settings: renderProfile,
};

// Routes a normal user must never reach, even by typing the hash directly.
const ADMIN_ONLY = new Set(['users', 'providers']);

function parseHash() {
  const raw = (location.hash || '#/dashboard').replace(/^#\/?/, '');
  const [route, param] = raw.split('/');
  return { route: route || 'dashboard', param: param || null };
}

export const navigate = (path) => {
  location.hash = `#/${path}`;
};

/// Re-renders the current route, e.g. after a mutation.
export const refresh = () => renderRoute();

// --- Shell -----------------------------------------------------------------

function renderShell() {
  const isAdmin = state.user.role === 'SUPER_ADMIN';
  const nav = isAdmin ? ADMIN_NAV : USER_NAV;

  const sidebar = el('aside', { class: 'sidebar', id: 'sidebar' });
  const outlet = el('main', { class: 'content', id: 'outlet' });

  const closeSidebar = () => {
    sidebar.classList.remove('open');
    document.getElementById('scrim')?.remove();
  };

  const toggleSidebar = () => {
    const opening = !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', opening);
    if (opening) {
      const scrim = el('div', { class: 'scrim', id: 'scrim', onclick: closeSidebar });
      document.body.append(scrim);
    } else {
      closeSidebar();
    }
  };

  sidebar.append(
    el('div', { class: 'nav-label' }, isAdmin ? 'Super Admin' : 'Menu'),
    ...nav.map((item) =>
      el(
        'button',
        {
          class: 'nav-item',
          dataset: { route: item.route },
          onclick: () => {
            navigate(item.route);
            closeSidebar();
          },
        },
        el('span', { class: 'ico' }, icon(item.icon)),
        item.label,
      ),
    ),
  );

  const topbar = el(
    'header',
    { class: 'topbar' },
    el('button', { class: 'menu-toggle', onclick: toggleSidebar, 'aria-label': 'Toggle menu' }, '☰'),
    el(
      'div',
      { class: 'brand' },
      el('span', { class: 'logo' }, icon('cloud', 17)),
      el('span', { class: 'label' }, 'Hosting Portal'),
    ),
    el('div', { class: 'spacer' }),
    el(
      'div',
      { class: 'topbar-user' },
      el(
        'div',
        { class: 'who' },
        el('div', { class: 'name' }, state.user.name),
        el('div', { class: 'role' }, isAdmin ? 'Super Admin' : 'User'),
      ),
      el('div', { class: 'avatar' }, initials(state.user.name)),
      el('button', { class: 'btn sm ghost', style: 'color:#cdd5e8', onclick: signOut }, 'Sign out'),
    ),
  );

  clear(root).append(el('div', { class: 'shell' }, topbar, sidebar, outlet));
}

async function signOut() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } finally {
    state.user = null;
    location.hash = '';
    start();
  }
}

function markActiveNav(route) {
  // The domain manage page is a child of Domains, so keep that item lit.
  const active = route === 'domain' ? 'domains' : route;
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.route === active);
  });
}

async function renderRoute() {
  if (!state.user) return;

  let { route, param } = parseHash();

  if (!VIEWS[route]) route = 'dashboard';
  if (ADMIN_ONLY.has(route) && state.user.role !== 'SUPER_ADMIN') {
    toast('That area is only available to Super Admins.', 'error');
    route = 'dashboard';
    location.hash = '#/dashboard';
  }

  markActiveNav(route);

  const outlet = document.getElementById('outlet');
  clear(outlet).append(el('div', { class: 'muted', style: 'padding:40px 0' }, 'Loading…'));

  try {
    const view = await VIEWS[route]({ param, user: state.user });
    clear(outlet).append(view);
    window.scrollTo(0, 0);
  } catch (err) {
    if (err.status === 401) return start();
    clear(outlet).append(el('div', { class: 'alert error' }, err.message));
  }
}

// --- Boot ------------------------------------------------------------------

async function start() {
  root.className = '';
  try {
    const { user } = await api('/auth/me');
    state.user = user;
  } catch {
    state.user = null;
  }

  if (!state.user) {
    clear(root).append(renderLogin(onSignedIn));
    return;
  }

  renderShell();
  if (!location.hash) location.hash = '#/dashboard';
  renderRoute();
}

function onSignedIn(user) {
  state.user = user;
  renderShell();
  location.hash = '#/dashboard';
  renderRoute();
}

window.addEventListener('hashchange', renderRoute);
start();
