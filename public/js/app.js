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
import { renderWebmail } from './views/webmail.js';
import { renderPlans } from './views/plans.js';
import { renderOrders } from './views/orders.js';
import { renderNotifications } from './views/notifications.js';
import { renderSystem } from './views/system.js';
import { renderBilling } from './views/billing.js';
import { renderTickets } from './views/tickets.js';

const root = document.getElementById('app');

export const state = { user: null };

// --- Navigation ------------------------------------------------------------

const ADMIN_NAV = [
  { route: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { route: 'domains', label: 'Domains', icon: 'globe' },
  { route: 'orders', label: 'Orders', icon: 'cart' },
  { route: 'plans', label: 'Plans & Pricing', icon: 'tag' },
  { route: 'billing', label: 'Invoices & Quotes', icon: 'receipt' },
  { route: 'support', label: 'Support', icon: 'lifebuoy' },
  { route: 'users', label: 'Users', icon: 'users' },
  { route: 'providers', label: 'Providers / APIs', icon: 'plug' },
  { route: 'resources', label: 'Server Resources', icon: 'server' },
  { route: 'system', label: 'System', icon: 'clock' },
  { route: 'alerts', label: 'Alerts & Activity', icon: 'bell' },
  { route: 'settings', label: 'Settings', icon: 'settings' },
];

const USER_NAV = [
  { route: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { route: 'domains', label: 'My Domains', icon: 'globe' },
  { route: 'emails', label: 'Emails', icon: 'mail' },
  { route: 'billing', label: 'My Invoices', icon: 'receipt' },
  { route: 'support', label: 'Support', icon: 'lifebuoy' },
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
  mail: renderWebmail,
  orders: renderOrders,
  plans: renderPlans,
  alerts: renderNotifications,
  system: renderSystem,
  billing: renderBilling,
  support: renderTickets,
};

// Routes a normal user must never reach, even by typing the hash directly.
const ADMIN_ONLY = new Set(['users', 'providers', 'orders', 'plans', 'alerts', 'system']);

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
    themeToggle(),
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

/// Light or dark, remembered per browser.
///
/// The icon shows what pressing it will give you, not what you have — a sun
/// on a dark page means "make it light", which is what somebody reaching for
/// it is after.
function themeToggle() {
  const button = el('button', {
    class: 'icon-btn',
    title: 'Switch between light and dark',
    'aria-label': 'Switch between light and dark',
  });

  const paint = () => {
    const dark = window.__theme?.current() === 'dark';
    clear(button).append(icon(dark ? 'sun' : 'moon', 17));
  };

  button.onclick = () => {
    window.__theme?.set();
    paint();
  };

  paint();
  // The operating system can change under us — a machine that switches at
  // sunset — and the icon should not then be lying.
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', paint);

  return button;
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
  const active = route === 'domain' ? 'domains' : route === 'mail' ? 'emails' : route;
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
  clear(outlet).append(loadingSkeleton());

  try {
    const view = await VIEWS[route]({ param, user: state.user });
    clear(outlet).append(view);
    window.scrollTo(0, 0);
  } catch (err) {
    if (err.status === 401) return start();
    clear(outlet).append(el('div', { class: 'alert error' }, err.message));
  }
}

/// The shape of a page, while the page is on its way.
///
/// A skeleton rather than the word "Loading" for two reasons: it says what is
/// coming, and it holds the height, so the content does not shove the page
/// around when it arrives.
const loadingSkeleton = () =>
  el(
    'div',
    { class: 'fade-in', style: 'padding:6px 0' },
    el('div', { class: 'skeleton line short', style: 'height:26px;margin-bottom:22px' }),
    el(
      'div',
      { class: 'stat-grid' },
      ...Array.from({ length: 4 }, () => el('div', { class: 'skeleton block' })),
    ),
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'card-body' },
        el('div', { class: 'skeleton line mid' }),
        el('div', { class: 'skeleton line' }),
        el('div', { class: 'skeleton line short' }),
      ),
    ),
  );

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
