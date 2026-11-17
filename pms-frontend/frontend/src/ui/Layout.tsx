import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth, useBranch } from '../lib/auth';
import { NAV, NavItem } from '../lib/nav';
import { useOnline, useQueueCount } from '../pos/offline';

function BranchPicker() {
  const { branchId, setBranchId } = useBranch(); const { branchesFor, can } = useAuth();
  const q = useQuery({ queryKey: ['lookup', '/branches'], staleTime: 300_000, queryFn: async () => (await api.list('/branches', { pageSize: 100 })).items });
  const allowed = branchesFor('branches.read');
  const list = (q.data ?? []).filter((b) => b.status === 'active' && (allowed === null || allowed.includes(b.id)));
  useEffect(() => { if (list.length && (!branchId || !list.some((b) => b.id === branchId))) setBranchId(list[0].id); }, [list.length]); // eslint-disable-line
  if (!can('branches.read') || list.length === 0) return null;
  return (
    <div className="relative inline-flex items-center">
      <span className="pointer-events-none absolute left-2.5 text-slate-400">
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
        </svg>
      </span>
      <select
        aria-label="Working branch"
        className="input w-auto py-1 pl-7 pr-6 text-xs font-medium border-slate-300"
        value={branchId ?? ''}
        onChange={(e) => setBranchId(e.target.value)}
      >
        {list.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
    </div>
  );
}

function Bell() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['unread'], refetchInterval: 60_000, queryFn: () => api.get<{ unread: number; critical: number }>('/notifications/unread-count') });
  const n = q.data?.unread ?? 0;
  return (
    <button
      className="relative btn-ghost px-2 py-1 text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
      aria-label={`Notifications, ${n} unread`}
      onClick={() => nav('/notifications')}
    >
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
      </svg>
      {n > 0 && (
        <span className="absolute -top-1 -right-1 flex h-4 min-w-[1rem] items-center justify-center rounded bg-red-600 px-1 text-[10px] font-bold text-white shadow-xs">
          {n > 99 ? '99+' : n}
        </span>
      )}
    </button>
  );
}

function GroupIcon({ title, className = 'h-4 w-4' }: { title: string; className?: string }) {
  switch (title) {
    case 'Overview':
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
        </svg>
      );
    case 'Selling':
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
        </svg>
      );
    case 'Stock':
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
      );
    case 'Buying':
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      );
    case 'Finance':
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case 'Reports':
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      );
    case 'Setup':
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      );
    default:
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      );
  }
}

export function Layout() {
  const { me, logout, can } = useAuth();
  const [open, setOpen] = useState(false); // Mobile drawer state
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('pms_sidebar_collapsed') === 'true';
    } catch {
      return false;
    }
  });
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('pms_nav_expanded');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const loc = useLocation();
  const online = useOnline();
  const queued = useQueueCount();

  const isItemActive = (to: string) => {
    if (to === '/') return loc.pathname === '/';
    return loc.pathname === to || loc.pathname.startsWith(to + '/');
  };

  const visible = (i: NavItem) => {
    if (!i.permission) return true;
    const ps = Array.isArray(i.permission) ? i.permission : [i.permission];
    return i.anyOf ? ps.some((p) => can(p)) : ps.every((p) => can(p));
  };

  const groups = NAV.map((g) => ({ ...g, items: g.items.filter(visible) })).filter((g) => g.items.length);
  const fullscreen = loc.pathname === '/pos';
  const initial = (me?.user.full_name ?? me?.user.username ?? 'U').charAt(0).toUpperCase();

  // Close mobile drawer on route change & auto-expand current group
  useEffect(() => {
    setOpen(false);
    setHoveredGroup(null);
    const activeGroup = groups.find((g) => g.items.some((i) => isItemActive(i.to)));
    if (activeGroup) {
      setExpandedGroups((prev) => {
        if (prev[activeGroup.title] === false) {
          const next = { ...prev, [activeGroup.title]: true };
          try { localStorage.setItem('pms_nav_expanded', JSON.stringify(next)); } catch { /* ignore */ }
          return next;
        }
        return prev;
      });
    }
  }, [loc.pathname]); // eslint-disable-line

  // Global Ctrl+B shortcut to toggle desktop sidebar
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setCollapsed((prev) => {
          const next = !prev;
          try { localStorage.setItem('pms_sidebar_collapsed', String(next)); } catch { /* ignore */ }
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const toggleGroup = (title: string) => {
    setExpandedGroups((prev) => {
      // If key is undefined, treat as open currently (default is open), so next is false
      const current = prev[title] !== false;
      const next = { ...prev, [title]: !current };
      try { localStorage.setItem('pms_nav_expanded', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const allOpen = groups.every((g) => expandedGroups[g.title] !== false);
  const toggleAllGroups = () => {
    const nextState = !allOpen;
    const next: Record<string, boolean> = {};
    for (const g of groups) next[g.title] = nextState;
    setExpandedGroups(next);
    try { localStorage.setItem('pms_nav_expanded', JSON.stringify(next)); } catch { /* ignore */ }
  };

  const toggleSidebar = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem('pms_sidebar_collapsed', String(next)); } catch { /* ignore */ }
      return next;
    });
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-100/80 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {!fullscreen && (
        <>
          {open && (
            <div
              className="fixed inset-0 z-30 bg-slate-900/50 lg:hidden"
              onClick={() => setOpen(false)}
            />
          )}

          <aside
            className={`fixed inset-y-0 left-0 z-40 flex h-full flex-col border-r border-slate-200 bg-white transition-all duration-200 dark:border-slate-800 dark:bg-slate-900 lg:static lg:h-full lg:translate-x-0 ${
              open ? 'translate-x-0 shadow-xl w-72' : '-translate-x-full'
            } ${collapsed ? 'lg:w-16' : 'lg:w-60'}`}
          >
            {/* ==================== 1. MINI RAIL (Desktop Collapsed View) ==================== */}
            <div className={`hidden ${collapsed ? 'lg:flex lg:h-full lg:w-16 lg:flex-col lg:justify-between' : ''}`}>
              {/* Top Logo */}
              <div className="flex shrink-0 items-center justify-center border-b border-slate-200 py-3 dark:border-slate-800">
                <button
                  type="button"
                  onClick={toggleSidebar}
                  title="Expand sidebar (Ctrl+B)"
                  className="flex h-7 w-7 items-center justify-center rounded bg-slate-900 text-white dark:bg-brand-600 transition-colors"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 10.5h-5.5V5c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v5.5H5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5h5.5V19c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5v-5.5H19c.83 0 1.5-.67 1.5-1.5s-.67-1.5-1.5-1.5z" />
                  </svg>
                </button>
              </div>

              {/* Middle Group Icons with Hover Popovers */}
              <div className="flex-1 overflow-y-auto px-2 py-2.5 space-y-1">
                {groups.map((g) => {
                  const groupActive = g.items.some((i) => isItemActive(i.to));
                  const isHovered = hoveredGroup === g.title;
                  const isNearBottom = ['Finance', 'Reports', 'Setup'].includes(g.title);

                  return (
                    <div
                      key={g.title}
                      className="relative"
                      onMouseEnter={() => setHoveredGroup(g.title)}
                      onMouseLeave={() => setHoveredGroup(null)}
                    >
                      <button
                        type="button"
                        onClick={() => setHoveredGroup(isHovered ? null : g.title)}
                        className={`group relative flex h-9 w-9 mx-auto items-center justify-center rounded transition-colors ${
                          groupActive
                            ? 'bg-brand-50 text-brand-700 dark:bg-brand-950/70 dark:text-brand-300'
                            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'
                        }`}
                        title={g.title}
                        aria-label={g.title}
                      >
                        <GroupIcon title={g.title} className="h-4 w-4" />
                        {groupActive && (
                          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-brand-600 ring-2 ring-white dark:ring-slate-900" />
                        )}
                      </button>

                      {/* Popover Flyout */}
                      {isHovered && (
                        <div className={`absolute left-full ${isNearBottom ? 'bottom-0' : 'top-0'} z-50 ml-1.5 w-52 rounded border border-slate-200 bg-white p-1.5 shadow-lg dark:border-slate-700 dark:bg-slate-900`}>
                          <div className="flex items-center gap-2 border-b border-slate-100 px-2 pb-1.5 pt-0.5 font-bold text-xs uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:text-slate-400">
                            <GroupIcon title={g.title} className="h-3.5 w-3.5 text-brand-600 dark:text-brand-400" />
                            <span>{g.title}</span>
                          </div>
                          <div className="mt-1 space-y-0.5 max-h-72 overflow-y-auto">
                            {g.items.map((i) => {
                              const active = isItemActive(i.to);
                              return (
                                <NavLink
                                  key={i.to}
                                  to={i.to}
                                  end={i.to === '/'}
                                  onClick={() => setHoveredGroup(null)}
                                  className={`block rounded px-2 py-1 text-xs font-medium transition-colors ${
                                    active
                                      ? 'bg-brand-50 text-brand-700 font-semibold dark:bg-brand-950/80 dark:text-brand-300'
                                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'
                                  }`}
                                >
                                  {i.label}
                                </NavLink>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Bottom Expand Toggle & Avatar */}
              <div className="shrink-0 border-t border-slate-200 p-2 dark:border-slate-800 flex flex-col items-center gap-1.5">
                <NavLink
                  to="/account"
                  className="flex h-7 w-7 items-center justify-center rounded bg-slate-200 text-slate-700 font-bold text-xs dark:bg-slate-700 dark:text-slate-200 hover:ring-1 hover:ring-slate-400 transition-all"
                  title={me?.user.full_name ?? me?.user.username}
                >
                  {initial}
                </NavLink>
                <button
                  type="button"
                  onClick={toggleSidebar}
                  className="flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition-colors"
                  title="Expand sidebar (Ctrl+B)"
                  aria-label="Expand sidebar"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>

            {/* ==================== 2. FULL EXPANDED MENU ==================== */}
            <div className={`flex flex-col h-full ${collapsed ? 'lg:hidden' : ''}`}>
              {/* Header */}
              <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2.5 dark:border-slate-800">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-slate-900 text-white dark:bg-brand-600">
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 10.5h-5.5V5c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v5.5H5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5h5.5V19c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5v-5.5H19c.83 0 1.5-.67 1.5-1.5s-.67-1.5-1.5-1.5z" />
                    </svg>
                  </div>
                  <div className="truncate">
                    <div className="text-xs font-bold uppercase tracking-wider text-slate-900 dark:text-white leading-tight truncate">Pharmacy PMS</div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-widest leading-none truncate">Enterprise</div>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  {/* Desktop collapse button */}
                  <button
                    type="button"
                    className="btn-ghost hidden lg:flex p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    onClick={toggleSidebar}
                    title="Collapse sidebar (Ctrl+B)"
                    aria-label="Collapse sidebar"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                    </svg>
                  </button>

                  {/* Mobile close button */}
                  <button
                    type="button"
                    className="btn-ghost p-1 lg:hidden text-slate-400 hover:text-slate-600"
                    onClick={() => setOpen(false)}
                    aria-label="Close menu"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Navigation Items (Expandable Accordion Groups) */}
              <div className="flex-1 overflow-y-auto px-2.5 py-2.5">
                {/* Accordion header controls */}
                <div className="mb-2 flex items-center justify-between px-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  <span>Navigation</span>
                  <button
                    type="button"
                    onClick={toggleAllGroups}
                    className="text-[10px] lowercase tracking-normal text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
                  >
                    {allOpen ? 'collapse all' : 'expand all'}
                  </button>
                </div>

                {groups.map((g) => {
                  const isOpen = expandedGroups[g.title] !== false;
                  const groupActive = g.items.some((i) => isItemActive(i.to));

                  return (
                    <div key={g.title} className="mb-1.5">
                      {/* Accordion Group Header */}
                      <button
                        type="button"
                        onClick={() => toggleGroup(g.title)}
                        className={`group flex w-full items-center justify-between rounded px-2 py-1 text-left transition-colors ${
                          groupActive && !isOpen
                            ? 'bg-brand-50/70 dark:bg-brand-950/40 text-brand-700 dark:text-brand-300 font-semibold'
                            : 'hover:bg-slate-100/80 dark:hover:bg-slate-800/60'
                        }`}
                        aria-expanded={isOpen}
                      >
                        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 group-hover:text-slate-900 dark:group-hover:text-slate-100">
                          <GroupIcon
                            title={g.title}
                            className={`h-3.5 w-3.5 transition-colors ${
                              groupActive
                                ? 'text-brand-600 dark:text-brand-400'
                                : 'text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300'
                            }`}
                          />
                          <span>{g.title}</span>
                          {groupActive && !isOpen && (
                            <span className="h-1.5 w-1.5 rounded-full bg-brand-600" />
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-slate-400 dark:text-slate-500 tabular-nums">
                            {g.items.length}
                          </span>
                          <svg
                            className={`h-3 w-3 text-slate-400 transition-transform duration-200 ${isOpen ? 'rotate-90' : 'rotate-0'}`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                          </svg>
                        </div>
                      </button>

                      {/* Accordion Group Items */}
                      {isOpen && (
                        <div className="mt-0.5 space-y-0.5 pl-2 ml-2.5 border-l border-slate-200 dark:border-slate-800">
                          {g.items.map((i) => (
                            <NavLink
                              key={i.to}
                              to={i.to}
                              end={i.to === '/'}
                              className={({ isActive }) =>
                                `block rounded px-2 py-1 text-xs font-medium transition-colors ${
                                  isActive
                                    ? 'bg-brand-50 text-brand-700 font-semibold dark:bg-brand-950/70 dark:text-brand-300'
                                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-850 dark:hover:text-slate-200'
                                }`
                              }
                            >
                              {i.label}
                            </NavLink>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* User Profile Footer */}
              <div className="shrink-0 border-t border-slate-200 p-2.5 dark:border-slate-800">
                <NavLink
                  to="/account"
                  className="flex items-center gap-2 rounded p-1.5 text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 transition-colors"
                >
                  <div className="flex h-6 w-6 items-center justify-center rounded bg-slate-200 text-slate-700 font-bold text-xs dark:bg-slate-700 dark:text-slate-200">
                    {initial}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-slate-800 dark:text-white leading-tight">
                      {me?.user.full_name ?? me?.user.username}
                    </div>
                    <div className="truncate text-[10px] text-slate-500">
                      {me?.roles?.map((r) => r.name).join(', ') || 'Account'}
                    </div>
                  </div>
                </NavLink>
              </div>
            </div>
          </aside>
        </>
      )}

      {/* Main Content Column */}
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <header className="shrink-0 z-30 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3.5 py-2 dark:border-slate-800 dark:bg-slate-900">
          {!fullscreen && (
            <>
              {/* Mobile menu hamburger */}
              <button
                className="btn-ghost px-2 py-1 lg:hidden text-slate-600 dark:text-slate-300"
                aria-label="Menu"
                onClick={() => setOpen(!open)}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>

              {/* Desktop sidebar toggle button */}
              <button
                type="button"
                className="btn-ghost hidden lg:flex items-center justify-center p-1.5 text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
                onClick={toggleSidebar}
                title={collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  {collapsed ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h10M4 18h16" />
                  )}
                </svg>
              </button>
            </>
          )}

          {fullscreen && (
            <NavLink to="/" className="btn-ghost py-1 text-xs font-medium">
              ← Back to App
            </NavLink>
          )}

          <BranchPicker />

          <div className="flex-1" />

          {!online && (
            <span className="inline-flex items-center gap-1.5 rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              Offline
            </span>
          )}

          {queued > 0 && (
            <NavLink
              to="/offline"
              className="inline-flex items-center gap-1.5 rounded border border-brand-200 bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-800 hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950/60 dark:text-brand-200"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-brand-600" />
              {queued} sale{queued === 1 ? '' : 's'} waiting to sync
            </NavLink>
          )}

          <Bell />

          <div className="hidden sm:flex items-center gap-2 pl-1 border-l border-slate-200 dark:border-slate-800">
            <NavLink
              to="/account"
              className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 transition-colors"
            >
              <div className="flex h-6 w-6 items-center justify-center rounded bg-slate-200 text-slate-700 font-bold text-[11px] dark:bg-slate-700 dark:text-slate-200">
                {initial}
              </div>
              <span className="font-semibold text-slate-800 dark:text-slate-200">{me?.user.full_name ?? me?.user.username}</span>
            </NavLink>
          </div>

          <button
            className="btn-ghost py-1 px-2.5 text-xs font-medium text-slate-600 hover:text-red-700 dark:text-slate-400 dark:hover:text-red-400"
            onClick={() => void logout()}
          >
            Sign out
          </button>
        </header>

        {/* Scrollable Main Content Body */}
        <main className={`min-w-0 flex-1 overflow-y-auto ${fullscreen ? 'p-2' : 'p-4 lg:p-5'}`}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
