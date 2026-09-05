import {
  Archive,
  BookOpenText,
  Cable,
  ChevronLeft,
  ChevronRight,
  FileCheck2,
  FolderKanban,
  FolderTree,
  Import,
  Lightbulb,
  ListTodo,
  Menu,
  Milestone,
  Network,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  loadPreference,
  preferenceKeys,
  savePreference,
  type SidebarPreference,
} from "../preferences.js";
import { navigate, useRoute } from "../router.js";
import { ThemeToggle } from "./theme-toggle.js";

export interface ActiveProjectNavigation {
  id: string;
  name: string;
  currentTaskId?: string | null;
}

export interface AppShellProps {
  children: ReactNode;
  activeProject?: ActiveProjectNavigation | null;
}

interface NavigationItem {
  label: string;
  path: string;
  icon: LucideIcon;
}

interface NavigationGroup {
  label: "Actions" | "Information";
  items: NavigationItem[];
}

const sidebarValues = ["expanded", "collapsed"] as const;

const isCurrentNavigationPath = (route: string, path: string): boolean =>
  path === "/"
    ? route === "/" || route === "/projects"
    : route === path || (
      path.endsWith("/documentation") && route.startsWith(`${path}/`)
    );

export function AppShell({
  children,
  activeProject = null,
}: AppShellProps) {
  const route = useRoute();
  const [sidebar, setSidebar] = useState<SidebarPreference>(
    () => loadPreference(
      preferenceKeys.sidebar,
      sidebarValues,
    ) ?? "expanded",
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const returnFocusAfterCloseRef = useRef(false);

  const closeDrawer = useCallback(() => {
    returnFocusAfterCloseRef.current = true;
    setDrawerOpen(false);
  }, []);

  useEffect(() => {
    const mobileViewport = window.matchMedia("(max-width: 759px)");
    const closeAtDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) return;
      returnFocusAfterCloseRef.current = false;
      setDrawerOpen(false);
    };
    mobileViewport.addEventListener("change", closeAtDesktop);
    return () => mobileViewport.removeEventListener("change", closeAtDesktop);
  }, []);

  useEffect(() => {
    if (!drawerOpen) {
      if (returnFocusAfterCloseRef.current) {
        returnFocusAfterCloseRef.current = false;
        drawerTriggerRef.current?.focus();
      }
      return;
    }
    drawerCloseRef.current?.focus();
    const keepFocusInDrawer = (event: KeyboardEvent) => {
      const navigation = navigationRef.current;
      if (navigation?.closest("[inert]")) return;
      if (event.key === "Escape") {
        closeDrawer();
        return;
      }
      if (event.key !== "Tab") return;

      const first = drawerCloseRef.current;
      const last = navigation?.querySelector<HTMLElement>(
        ".sidebar__footer .theme-toggle",
      );
      if (!navigation || !first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!navigation.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keepFocusInDrawer);
    return () => window.removeEventListener("keydown", keepFocusInDrawer);
  }, [closeDrawer, drawerOpen]);

  const navigationGroups: NavigationGroup[] = activeProject
    ? (() => {
    const projectPath = `/projects/${encodeURIComponent(activeProject.id)}`;
    const actions: NavigationItem[] = [
      {
        label: "Work Queue",
        path: `${projectPath}/work`,
        icon: ListTodo,
      },
      ...(activeProject.currentTaskId ? [{
        label: "Current Task",
        path: `${projectPath}/tasks/${encodeURIComponent(activeProject.currentTaskId)}/handoff`,
        icon: Network,
      }] : []),
      {
        label: "Proposals",
        path: `${projectPath}/proposals`,
        icon: FileCheck2,
      },
      {
        label: "Ideas",
        path: `${projectPath}/ideas`,
        icon: Lightbulb,
      },
      {
        label: "Import Project",
        path: "/projects/import",
        icon: Import,
      },
    ];
    return [
      { label: "Actions", items: actions },
      {
        label: "Information",
        items: [
          { label: "Overview", path: projectPath, icon: FolderKanban },
          { label: "Map", path: `${projectPath}/map`, icon: Milestone },
          {
            label: "Documentation",
            path: `${projectPath}/documentation`,
            icon: BookOpenText,
          },
          {
            label: "Repository",
            path: `${projectPath}/repository`,
            icon: FolderTree,
          },
        ],
      },
    ];
  })()
    : [];
  const followLink = (
    event: MouseEvent<HTMLAnchorElement>,
    path: string,
  ) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) return;
    event.preventDefault();
    navigate(path);
    if (drawerOpen) closeDrawer();
  };

  const toggleSidebar = () => {
    setSidebar((current) => {
      const next = current === "expanded" ? "collapsed" : "expanded";
      savePreference(preferenceKeys.sidebar, next);
      return next;
    });
  };
  const effectiveSidebar = drawerOpen ? "expanded" : sidebar;

  return (
    <div className="app-shell" data-sidebar-state={effectiveSidebar}>
      <header className="mobile-header" inert={drawerOpen}>
        <button
          ref={drawerTriggerRef}
          className="icon-button"
          type="button"
          aria-label="Open navigation"
          aria-controls="primary-navigation"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <Menu aria-hidden="true" size={20} />
        </button>
        <span className="mobile-header__brand">IntentArc</span>
        <ThemeToggle />
      </header>

      <button
        className="drawer-scrim"
        type="button"
        aria-label="Close navigation"
        aria-hidden="true"
        tabIndex={-1}
        data-open={drawerOpen ? "true" : "false"}
        onClick={closeDrawer}
      />

      <nav
        ref={navigationRef}
        id="primary-navigation"
        className="sidebar"
        aria-label="Primary"
        data-sidebar-state={effectiveSidebar}
        data-drawer-state={drawerOpen ? "open" : "closed"}
      >
        <div className="sidebar__header">
          <a
            className="brand"
            href="/"
            aria-label="IntentArc projects"
            onClick={(event) => followLink(event, "/")}
          >
            <span className="brand__seal" aria-hidden="true">
              <Archive size={19} strokeWidth={1.7} />
            </span>
            <span className="brand__wordmark">IntentArc</span>
          </a>
          <button
            ref={drawerCloseRef}
            className="sidebar__close icon-button"
            type="button"
            aria-label="Close navigation"
            onClick={closeDrawer}
          >
            <X aria-hidden="true" size={20} />
          </button>
        </div>

        {activeProject
          ? (
              <>
                <a
                  className="project-switcher"
                  href="/projects"
                  aria-label={`${activeProject.name} project switcher`}
                  aria-current={
                    isCurrentNavigationPath(route, "/projects")
                      ? "page"
                      : undefined
                  }
                  onClick={(event) => followLink(event, "/projects")}
                >
                  <FolderKanban aria-hidden="true" size={19} strokeWidth={1.75} />
                  <span className="project-switcher__label">
                    {activeProject.name}
                  </span>
                </a>
                <div className="sidebar__nav-groups">
                  {navigationGroups.map(({ label, items }) => (
                    <section className="sidebar__nav-group" key={label}>
                      <h2>{label}</h2>
                      <ul className="nav-list">
                        {items.map(({ label: itemLabel, path, icon: Icon }) => (
                          <li key={path}>
                            <a
                              className="nav-link"
                              href={path}
                              aria-label={
                                sidebar === "collapsed" ? itemLabel : undefined
                              }
                              aria-current={
                                isCurrentNavigationPath(route, path)
                                  ? "page"
                                  : undefined
                              }
                              title={
                                sidebar === "collapsed" ? itemLabel : undefined
                              }
                              onClick={(event) => followLink(event, path)}
                            >
                              <Icon
                                className="nav-link__icon"
                                aria-hidden="true"
                                size={19}
                                strokeWidth={1.75}
                              />
                              <span className="nav-link__label">{itemLabel}</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              </>
            )
          : null}

        <div className="sidebar__footer" role="group" aria-label="Preferences">
          <h2 className="sidebar__footer-heading">Preferences</h2>
          {window.intentArcDesktop
            ? (
                <a
                  className="preference-link"
                  href="/settings/ai"
                  aria-label={sidebar === "collapsed" ? "AI Connections" : undefined}
                  aria-current={
                    isCurrentNavigationPath(route, "/settings/ai")
                      ? "page"
                      : undefined
                  }
                  title={sidebar === "collapsed" ? "AI Connections" : undefined}
                  onClick={(event) => followLink(event, "/settings/ai")}
                >
                  <Cable aria-hidden="true" size={19} strokeWidth={1.75} />
                  <span className="preference-link__label">AI Connections</span>
                </a>
              )
            : null}
          <ThemeToggle />
          <button
            className="sidebar-toggle"
            type="button"
            aria-label={
              sidebar === "expanded"
                ? "Collapse navigation"
                : "Expand navigation"
            }
            title={
              sidebar === "expanded"
                ? "Collapse navigation"
                : "Expand navigation"
            }
            onClick={toggleSidebar}
          >
            {sidebar === "expanded"
              ? <ChevronLeft aria-hidden="true" size={18} />
              : <ChevronRight aria-hidden="true" size={18} />}
            <span className="sidebar-toggle__label">
              {sidebar === "expanded" ? "Collapse" : "Expand"}
            </span>
          </button>
        </div>
      </nav>

      <main
        className="content-stage"
        id="main-content"
        inert={drawerOpen}
      >
        {children}
      </main>
    </div>
  );
}
