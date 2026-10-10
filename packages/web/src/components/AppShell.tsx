import { AppShell as MantineShell, Badge } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { NavLink, Outlet } from 'react-router';
import { useInbox } from '../api/hooks';
import { DriveIcon, GridIcon, InboxIcon, SettingsIcon } from './icons';
import { ProviderBanner } from './ProviderBanner';
import { ProviderStatusLine } from './ProviderStatusLine';

const NAV = [
  { to: '/', label: 'Layout', icon: GridIcon, end: true },
  { to: '/drives', label: 'Drives', icon: DriveIcon, end: false },
  { to: '/inbox', label: 'Inbox', icon: InboxIcon, end: false },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, end: false },
] as const;

/** Sidebar on desktop, bottom tab bar on phone (<= 768px). */
export function AppShell() {
  const phone = useMediaQuery('(max-width: 48em)') ?? false;
  const inbox = useInbox();
  const count = inbox.data?.count ?? 0;

  const links = (cls: string) =>
    NAV.map(({ to, label, icon: Icon, end }) => (
      <NavLink
        key={to}
        to={to}
        end={end}
        className={({ isActive }) => `${cls}${isActive ? ' active' : ''}`}
      >
        <span className="nav-icon">
          <Icon size={cls === 'tab' ? 22 : 18} />
          {cls === 'tab' && to === '/inbox' && count > 0 ? (
            <Badge
              size="xs"
              circle
              color="indigo"
              className="tab-badge"
              aria-label={`${count} in inbox`}
            >
              {count}
            </Badge>
          ) : null}
        </span>
        <span className="nav-label">{label}</span>
        {cls === 'nav-link' && to === '/inbox' && count > 0 ? (
          <Badge
            size="sm"
            circle
            color="indigo"
            className="nav-badge"
            aria-label={`${count} in inbox`}
          >
            {count}
          </Badge>
        ) : null}
      </NavLink>
    ));

  return (
    <MantineShell
      navbar={{ width: 232, breakpoint: 'sm', collapsed: { mobile: true } }}
      footer={{ height: 64, collapsed: !phone }}
      padding={0}
    >
      <MantineShell.Navbar className="sidebar" component="nav" aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Sparrow
        </div>
        <div className="nav-links">{links('nav-link')}</div>
        <ProviderStatusLine />
      </MantineShell.Navbar>
      <MantineShell.Main>
        <div className="page">
          <ProviderBanner />
          {phone ? (
            <header className="page-head">
              <ProviderStatusLine />
            </header>
          ) : null}
          <Outlet />
        </div>
      </MantineShell.Main>
      {phone ? (
        <MantineShell.Footer className="tabbar" component="nav" aria-label="Main">
          {links('tab')}
        </MantineShell.Footer>
      ) : null}
    </MantineShell>
  );
}
