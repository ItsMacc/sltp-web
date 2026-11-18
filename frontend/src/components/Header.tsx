// Header.tsx — Top nav: brand, links, auth actions, mobile drawer
import { useEffect, useRef, useState } from 'react';
import Button from '../ui/Button';
import Logo from './Logo';
import UserMenu from './UserMenu';
import './Header.css';

interface HeaderProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  onAuthClick: (mode: 'login' | 'signup') => void;
  sessionUserName?: string | null;
  sessionUserEmail?: string | null;
  onSignOut: () => void;
  onSettingsClick: () => void;
}

/* Every page has a link, even the ones with no content yet: those land on
   their placeholder until the real page is built. */
const navItems = [
  { id: 'home', label: 'Home' },
  { id: 'research', label: 'Research' },
  { id: 'strategies', label: 'Strategies' },
  { id: 'lab', label: 'Lab' },
  { id: 'watchlist', label: 'Watchlist' },
  { id: 'learn', label: 'Learn' },
  { id: 'docs', label: 'Docs' },
];

export default function Header({ 
  activeTab, 
  onTabChange, 
  onAuthClick, 
  sessionUserName,
  sessionUserEmail, 
  onSignOut,
  onSettingsClick 
}: HeaderProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const hiddenNow = hidden && !mobileMenuOpen && !focusWithin;

  /* Hide while scrolling down, reveal on any scroll up or at the top.
     Small threshold so trackpad jitter doesn't flicker the bar. */
  useEffect(() => {
    let lastY = window.scrollY;
    let ticking = false;
    const update = () => {
      const y = window.scrollY;
      const delta = y - lastY;
      if (y <= 0 || delta < -8) setHidden(false);
      else if (delta > 8) setHidden(true);
      if (Math.abs(delta) > 8) lastY = y;
      ticking = false;
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Pages that keep a bar of their own under the header (
  // the Learn level tabs, the lesson rail) need its height and whether it is on
  // screen, or the bar parks on top of the header and disappears behind it.
  useEffect(() => {
    const root = document.documentElement;
    const publish = () => {
      const element = headerRef.current;
      if (element) root.style.setProperty('--site-header-h', `${Math.round(element.offsetHeight)}px`);
    };
    publish();
    const element = headerRef.current;
    const observer = element ? new ResizeObserver(publish) : null;
    if (element && observer) observer.observe(element);
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    // Mirrored onto the body so a sticky sibling can follow the header out.
    document.body.classList.toggle('site-header-hidden', hiddenNow);
  }, [hiddenNow]);

  const handleTabClick = (id: string) => {
    onTabChange(id);
    setMobileMenuOpen(false);
  };

  return (
    <header
      ref={headerRef}
      className={`header-container ${hiddenNow ? 'is-hidden' : ''}`}
      onFocus={() => setFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
      }}
    >
      <div className="header-brand" onClick={() => handleTabClick('home')}>
        <Logo height={30} />
        <span className="brand-title">SLTP</span>
      </div>

      <nav className="header-nav desktop-only">
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-link ${activeTab === item.id ? 'active' : ''}`}
            onClick={() => handleTabClick(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="header-actions">
        <div className="desktop-only auth-buttons-group">
          {sessionUserEmail ? (
            <UserMenu 
              userName={sessionUserName}
              userEmail={sessionUserEmail}
              onSettingsClick={onSettingsClick}
              onSignOut={onSignOut}
            />
          ) : (
            <>
              <Button variant="primary" size="md" onClick={() => onAuthClick('login')}>
                Sign In
              </Button>
              <Button variant="secondary" size="md" onClick={() => onAuthClick('signup')}>
                Sign Up
              </Button>
            </>
          )}
        </div>

        <button 
          type="button" 
          className={`hamburger-toggle ${mobileMenuOpen ? 'is-open' : ''}`}
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label="Toggle Navigation Menu"
        >
          <span className="hamburger-line"></span>
          <span className="hamburger-line"></span>
          <span className="hamburger-line"></span>
        </button>
      </div>

      {mobileMenuOpen && (
        <div className="mobile-menu-drawer">
          <nav className="mobile-nav-list">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`mobile-nav-link ${activeTab === item.id ? 'active' : ''}`}
                onClick={() => handleTabClick(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          
          <div className="mobile-auth-group">            {sessionUserEmail ? (
              <>
                <div className="mobile-user-info">
                  {sessionUserName && (
                    <span className="mobile-user-name">{sessionUserName}</span>
                  )}
                  <span className="mobile-user-email">
                    Signed in as&nbsp;{sessionUserEmail}
                  </span>
                </div>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => { setMobileMenuOpen(false); onSettingsClick(); }}
                >
                  Settings
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => { setMobileMenuOpen(false); onSignOut(); }}
                >
                  Sign Out
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => { setMobileMenuOpen(false); onAuthClick('login'); }}
                >
                  Sign In
                </Button>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => { setMobileMenuOpen(false); onAuthClick('signup'); }}
                >
                  Sign Up
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}