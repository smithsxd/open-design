import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  clearHostBrowserData,
  isOpenDesignHostAvailable,
} from '@open-design/host';
import {
  openExternalUrl,
  writeProjectBase64File,
  writeProjectTextFile,
} from '../providers/registry';
import { Icon } from './Icon';

type BrowserHistoryEntry = {
  title: string;
  url: string;
  lastVisitedAt: number;
  visitCount: number;
};

type ReferenceSite = {
  label: string;
  url: string;
  detail: string;
};

type ReferenceGroup = {
  title: string;
  sites: ReferenceSite[];
};

type PageBrief = {
  title?: string;
  url?: string;
  description?: string;
  headings?: string[];
  images?: string[];
  links?: { text: string; url: string }[];
  colors?: { value: string; count: number }[];
};

type WebviewElement = HTMLElement & {
  canGoBack(): boolean;
  canGoForward(): boolean;
  capturePage(): Promise<{ toDataURL(): string }>;
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
  getTitle(): string;
  getURL(): string;
  goBack(): void;
  goForward(): void;
  isLoading(): boolean;
  reload(): void;
  reloadIgnoringCache(): void;
};

type WebviewNavigationEvent = Event & {
  isMainFrame?: boolean;
  url?: string;
};

type WebviewTitleEvent = Event & {
  explicitSet?: boolean;
  title?: string;
};

interface DesignBrowserPanelProps {
  projectId: string;
  onOpenFile: (name: string) => void;
  onRefreshFiles: () => Promise<void> | void;
}

const EMPTY_URL = 'about:blank';
const DESIGN_BROWSER_PARTITION = 'persist:open-design-design-browser';
const HISTORY_LIMIT = 80;

const REFERENCE_GROUPS: ReferenceGroup[] = [
  {
    title: 'Motion',
    sites: [
      { label: 'GSAP', url: 'https://gsap.com/', detail: 'Production animation engine and examples.' },
      { label: 'Transitions', url: 'https://transitions.dev/', detail: 'Transition patterns for modern interfaces.' },
      { label: 'Motion Sites', url: 'https://motionsites.ai/', detail: 'High-end motion and interaction references.' },
      { label: 'Motion.page Showcase', url: 'https://motion.page/showcase/', detail: 'Scroll and timeline animation inspiration.' },
      { label: 'Animography', url: 'https://animography.net/', detail: 'Animated type and kinetic lettering.' },
    ],
  },
  {
    title: 'Assets',
    sites: [
      { label: 'The SVG', url: 'https://thesvg.org/', detail: 'SVG assets and vector references.' },
      { label: 'Unsplash', url: 'https://unsplash.com/', detail: 'Photography for visual direction.' },
      { label: 'Google Fonts', url: 'https://fonts.google.com/', detail: 'Typography exploration and pairing.' },
      { label: 'Whirrls', url: 'https://www.whirrls.com/', detail: 'Hand-drawn image references.' },
      { label: 'World in Dots', url: 'https://www.worldindots.com/', detail: 'Dot-map and data visualization references.' },
    ],
  },
  {
    title: 'Systems',
    sites: [
      { label: 'Styles Refero', url: 'https://styles.refero.design/', detail: 'Design style references and visual systems.' },
      { label: 'Brandfetch', url: 'https://brandfetch.com/', detail: 'Brand assets, logos, and company identity.' },
      { label: 'Toolfolio', url: 'https://toolfolio.io/', detail: 'Design tools, resources, and collections.' },
      { label: 'GetDesign', url: 'https://getdesign.md/', detail: 'Design resources and curated references.' },
      { label: 'Startups Gallery', url: 'https://startups.gallery/', detail: 'Top startup product and brand references.' },
    ],
  },
];

const PAGE_BRIEF_SCRIPT = `(() => {
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) || '';
  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .map((node) => clean(node.textContent))
    .filter(Boolean)
    .slice(0, 18);
  const links = Array.from(document.querySelectorAll('a[href]'))
    .map((node) => ({ text: clean(node.textContent), url: node.href }))
    .filter((item) => item.url && item.text)
    .slice(0, 28);
  const images = Array.from(document.images)
    .map((image) => image.currentSrc || image.src)
    .filter(Boolean)
    .slice(0, 24);
  const colorCounts = new Map();
  const transparent = new Set(['rgba(0, 0, 0, 0)', 'transparent']);
  for (const element of Array.from(document.querySelectorAll('body, body *')).slice(0, 700)) {
    const style = getComputedStyle(element);
    for (const prop of ['color', 'backgroundColor', 'borderColor']) {
      const value = style[prop];
      if (!value || transparent.has(value)) continue;
      colorCounts.set(value, (colorCounts.get(value) || 0) + 1);
    }
  }
  return {
    title: clean(document.title),
    url: location.href,
    description: clean(attr('meta[name="description"]', 'content') || attr('meta[property="og:description"]', 'content')),
    headings,
    images,
    links,
    colors: Array.from(colorCounts.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 16)
      .map(([value, count]) => ({ value, count })),
  };
})()`;

export function DesignBrowserPanel({
  projectId,
  onOpenFile,
  onRefreshFiles,
}: DesignBrowserPanelProps) {
  const desktopHostAvailable = isOpenDesignHostAvailable();
  // `loadUrl` is the navigation target bound to the <webview>/<iframe> `src`.
  // It changes ONLY on user-initiated navigation. `currentUrl` is the committed
  // location shown in the address bar and recorded in history, synced from the
  // webview's own navigation events. They are deliberately separate: if `src`
  // tracked every committed URL, a server redirect (e.g. adding a trailing
  // slash) would mutate `src` mid-load and Electron would abort the in-flight
  // navigation (ERR_ABORTED -3), leaving the page blank.
  const [loadUrl, setLoadUrl] = useState(EMPTY_URL);
  const [currentUrl, setCurrentUrl] = useState(EMPTY_URL);
  const [addressValue, setAddressValue] = useState('');
  const [history, setHistory] = useState<BrowserHistoryEntry[]>(() => loadHistory(projectId));
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [webviewNode, setWebviewNode] = useState<WebviewElement | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [savingAction, setSavingAction] = useState<'brief' | 'screenshot' | 'task' | null>(null);
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const assignWebviewNode = useCallback((node: HTMLWebViewElement | null) => {
    // Set `allowpopups` imperatively rather than as a JSX prop. React's DOM
    // renderer does not treat `allowpopups` as a known boolean attribute, so
    // passing it through JSX logs "Received `true` for a non-boolean
    // attribute" at runtime (only reproducible once the webview branch mounts
    // in the desktop host). The attribute must still reach Electron's <webview>
    // as a present string so the guest page may open popups.
    if (node) node.setAttribute('allowpopups', 'true');
    setWebviewNode(node as WebviewElement | null);
  }, []);

  useEffect(() => {
    setHistory(loadHistory(projectId));
    setLoadUrl(EMPTY_URL);
    setCurrentUrl(EMPTY_URL);
    setAddressValue('');
    setCanGoBack(false);
    setCanGoForward(false);
  }, [projectId]);

  useEffect(() => {
    saveHistory(projectId, history);
  }, [history, projectId]);

  useEffect(() => {
    if (!statusMessage) return;
    const timer = window.setTimeout(() => setStatusMessage(null), 2600);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  useEffect(() => {
    if (!menuOpen && !suggestionsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const chrome = chromeRef.current;
      if (chrome && event.target instanceof Node && chrome.contains(event.target)) return;
      setMenuOpen(false);
      setSuggestionsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen, suggestionsOpen]);

  const commitHistory = useCallback((url: string, title?: string) => {
    if (!isHistoryUrl(url)) return;
    setHistory((current) => {
      const now = Date.now();
      const existing = current.find((entry) => sameUrl(entry.url, url));
      const nextTitle = title && title.trim() ? title.trim() : labelFromUrl(url);
      const entry = existing
        ? { ...existing, title: nextTitle, lastVisitedAt: now, visitCount: existing.visitCount + 1 }
        : { title: nextTitle, url, lastVisitedAt: now, visitCount: 1 };
      return [entry, ...current.filter((item) => !sameUrl(item.url, url))]
        .slice(0, HISTORY_LIMIT);
    });
  }, []);

  const navigateTo = useCallback((rawAddress: string) => {
    const nextUrl = normalizeBrowserAddress(rawAddress);
    setLoadUrl(nextUrl);
    setCurrentUrl(nextUrl);
    setAddressValue(nextUrl === EMPTY_URL ? '' : nextUrl);
    setSuggestionsOpen(false);
    setMenuOpen(false);
    if (isHistoryUrl(nextUrl)) commitHistory(nextUrl);
  }, [commitHistory]);

  const updateNavigationState = useCallback((node: WebviewElement | null = webviewNode) => {
    if (!node) {
      setCanGoBack(false);
      setCanGoForward(false);
      setIsLoading(false);
      return;
    }
    // Electron's <webview> throws ("The WebView must be attached to the DOM and
    // the dom-ready event emitted before this method can be called") when
    // canGoBack/canGoForward/isLoading run before the guest attaches. The mount
    // effect calls this immediately, so guard like safeGetWebviewUrl/Title do.
    try {
      setCanGoBack(Boolean(node.canGoBack()));
      setCanGoForward(Boolean(node.canGoForward()));
      setIsLoading(Boolean(node.isLoading()));
    } catch {
      // Pre-dom-ready: keep the existing (default) navigation state.
    }
  }, [webviewNode]);

  useEffect(() => {
    const node = webviewNode;
    if (!node) return;

    const syncFromWebview = (url?: string, title?: string) => {
      const nextUrl = url || safeGetWebviewUrl(node);
      if (nextUrl) {
        setCurrentUrl(nextUrl);
        setAddressValue(nextUrl === EMPTY_URL ? '' : nextUrl);
      }
      const nextTitle = title || safeGetWebviewTitle(node);
      if (nextUrl) commitHistory(nextUrl, nextTitle);
      updateNavigationState(node);
    };
    const onStart = () => {
      setIsLoading(true);
      updateNavigationState(node);
    };
    const onStop = () => {
      setIsLoading(false);
      syncFromWebview();
    };
    const onNavigate = (event: Event) => {
      const navigationEvent = event as WebviewNavigationEvent;
      if (navigationEvent.isMainFrame === false) return;
      syncFromWebview(navigationEvent.url);
    };
    const onTitle = (event: Event) => {
      const titleEvent = event as WebviewTitleEvent;
      syncFromWebview(undefined, titleEvent.title);
    };
    const onFail = (event: Event) => {
      const navigationEvent = event as WebviewNavigationEvent;
      if (navigationEvent.isMainFrame === false) return;
      setIsLoading(false);
      updateNavigationState(node);
    };

    node.addEventListener('did-start-loading', onStart);
    node.addEventListener('did-stop-loading', onStop);
    node.addEventListener('did-navigate', onNavigate);
    node.addEventListener('did-navigate-in-page', onNavigate);
    node.addEventListener('page-title-updated', onTitle);
    node.addEventListener('did-fail-load', onFail);
    node.addEventListener('dom-ready', onStop);
    updateNavigationState(node);
    return () => {
      node.removeEventListener('did-start-loading', onStart);
      node.removeEventListener('did-stop-loading', onStop);
      node.removeEventListener('did-navigate', onNavigate);
      node.removeEventListener('did-navigate-in-page', onNavigate);
      node.removeEventListener('page-title-updated', onTitle);
      node.removeEventListener('did-fail-load', onFail);
      node.removeEventListener('dom-ready', onStop);
    };
  }, [commitHistory, updateNavigationState, webviewNode]);

  const suggestions = useMemo(() => {
    const query = addressValue.trim().toLocaleLowerCase();
    const referenceSuggestions = REFERENCE_GROUPS.flatMap((group) =>
      group.sites.map((site) => ({
        detail: `${group.title} - ${site.detail}`,
        id: `site:${site.url}`,
        label: site.label,
        type: 'Reference' as const,
        url: site.url,
      })),
    );
    const historySuggestions = history.map((entry) => ({
      detail: entry.url,
      id: `history:${entry.url}`,
      label: entry.title || labelFromUrl(entry.url),
      type: 'History' as const,
      url: entry.url,
    }));
    const all = [...historySuggestions, ...referenceSuggestions];
    if (!query) return all.slice(0, 12);
    return all
      .filter((item) =>
        `${item.label} ${item.url} ${item.detail}`.toLocaleLowerCase().includes(query),
      )
      .slice(0, 12);
  }, [addressValue, history]);

  const pageTitle = history.find((entry) => sameUrl(entry.url, currentUrl))?.title || labelFromUrl(currentUrl);
  // Drive the start-page/webview branch off the load target, not the committed
  // URL, so a transient about:blank navigation event can't unmount the webview.
  const isBlank = loadUrl === EMPTY_URL;

  async function handleAddressSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigateTo(addressValue);
  }

  async function copyCurrentUrl() {
    const text = isBlank ? '' : currentUrl;
    if (!text) {
      setStatusMessage('No URL to copy');
      return;
    }
    await copyText(text);
    setStatusMessage('URL copied');
    setMenuOpen(false);
  }

  async function openCurrentExternally() {
    if (isBlank || !isHttpLikeUrl(currentUrl)) {
      setStatusMessage('Open an http URL first');
      return;
    }
    await openExternalUrl(currentUrl);
    setMenuOpen(false);
  }

  async function takeScreenshot() {
    if (!webviewNode || isBlank) {
      setStatusMessage('Open a page before taking a screenshot');
      return;
    }
    setSavingAction('screenshot');
    try {
      const image = await webviewNode.capturePage();
      const base64 = image.toDataURL().split(',', 2)[1] ?? '';
      const file = await writeProjectBase64File(
        projectId,
        browserFileName('browser-capture', currentUrl, 'png'),
        base64,
      );
      if (!file) throw new Error('screenshot save failed');
      await onRefreshFiles();
      onOpenFile(file.name);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Screenshot failed');
    } finally {
      setSavingAction(null);
      setMenuOpen(false);
    }
  }

  async function savePageBrief() {
    if (!webviewNode || isBlank) {
      setStatusMessage('Open a page before saving a brief');
      return;
    }
    setSavingAction('brief');
    try {
      const brief = await webviewNode.executeJavaScript<PageBrief>(PAGE_BRIEF_SCRIPT, true);
      const file = await writeProjectTextFile(
        projectId,
        browserFileName('browser-brief', currentUrl, 'md'),
        pageBriefMarkdown(brief, currentUrl),
      );
      if (!file) throw new Error('brief save failed');
      await onRefreshFiles();
      onOpenFile(file.name);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Brief save failed');
    } finally {
      setSavingAction(null);
      setMenuOpen(false);
    }
  }

  async function saveHarnessTask(url = currentUrl) {
    if (url === EMPTY_URL) {
      setStatusMessage('Open a page before creating a task');
      return;
    }
    setSavingAction('task');
    try {
      const content = browserHarnessTaskMarkdown(projectId, url);
      await copyText(content);
      const file = await writeProjectTextFile(
        projectId,
        browserFileName('browser-harness-task', url, 'md'),
        content,
      );
      if (!file) throw new Error('task save failed');
      await onRefreshFiles();
      onOpenFile(file.name);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Task save failed');
    } finally {
      setSavingAction(null);
      setMenuOpen(false);
    }
  }

  async function clearCookies(storage: boolean) {
    if (!desktopHostAvailable) {
      setStatusMessage('Desktop browser data is unavailable here');
      return;
    }
    const result = await clearHostBrowserData({ cookies: true, storage });
    setStatusMessage(result.ok ? 'Browser data cleared' : result.reason);
    if (storage) {
      setHistory([]);
      setLoadUrl(EMPTY_URL);
      setCurrentUrl(EMPTY_URL);
      setAddressValue('');
    }
    setMenuOpen(false);
  }

  function clearHistoryOnly() {
    setHistory([]);
    setStatusMessage('History cleared');
    setMenuOpen(false);
  }

  function reload(hard = false) {
    if (isBlank) return;
    if (webviewNode) {
      // Reload is enabled as soon as a URL is set, which can be before the
      // <webview> emits dom-ready; reload()/reloadIgnoringCache() throw in that
      // window. Guard so an early click can't crash the panel.
      try {
        if (hard) webviewNode.reloadIgnoringCache();
        else webviewNode.reload();
      } catch {
        setLoadUrl((url) => `${url}${url.includes('?') ? '&' : '?'}odReload=${Date.now()}`);
      }
    } else {
      setLoadUrl((url) => `${url}${url.includes('?') ? '&' : '?'}odReload=${Date.now()}`);
    }
    setMenuOpen(false);
  }

  return (
    <section className="design-browser" aria-label="Design Browser">
      <div className="db-chrome" ref={chromeRef}>
        <div className="db-nav">
          <button
            type="button"
            className="db-icon-btn"
            aria-label="Back"
            title="Back"
            disabled={!canGoBack}
            onClick={() => webviewNode?.goBack()}
          >
            <Icon name="chevron-left" size={16} />
          </button>
          <button
            type="button"
            className="db-icon-btn"
            aria-label="Forward"
            title="Forward"
            disabled={!canGoForward}
            onClick={() => webviewNode?.goForward()}
          >
            <Icon name="chevron-right" size={16} />
          </button>
          <button
            type="button"
            className={`db-icon-btn ${isLoading ? 'is-spinning' : ''}`}
            aria-label="Reload"
            title="Reload"
            disabled={isBlank}
            onClick={() => reload(false)}
          >
            <Icon name="reload" size={15} />
          </button>
        </div>
        <form className="db-address-form" onSubmit={handleAddressSubmit}>
          <Icon name="globe" size={15} />
          <input
            value={addressValue}
            onChange={(event) => {
              setAddressValue(event.target.value);
              setSuggestionsOpen(true);
            }}
            onFocus={() => setSuggestionsOpen(true)}
            placeholder="Enter URL or search..."
            aria-label="Browser address"
            autoComplete="off"
            spellCheck={false}
          />
          {suggestionsOpen && suggestions.length > 0 ? (
            <div className="db-suggestions" role="listbox">
              {suggestions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  onClick={() => navigateTo(item.url)}
                >
                  <span className="db-suggestion-icon">
                    <Icon name={item.type === 'History' ? 'history' : 'sparkles'} size={14} />
                  </span>
                  <span className="db-suggestion-copy">
                    <span>{item.label}</span>
                    <small>{item.detail}</small>
                  </span>
                  <span className="db-suggestion-type">{item.type}</span>
                </button>
              ))}
            </div>
          ) : null}
        </form>
        <div className="db-actions">
          <button
            type="button"
            className="db-icon-btn"
            aria-label="Save page brief"
            title="Save page brief"
            disabled={isBlank || savingAction != null}
            onClick={savePageBrief}
          >
            <Icon name="file-code" size={15} />
          </button>
          <button
            type="button"
            className="db-icon-btn"
            aria-label="Browser menu"
            title="Browser menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Icon name="more-horizontal" size={16} />
          </button>
          {menuOpen ? (
            <div className="db-menu" role="menu">
              <button type="button" role="menuitem" onClick={takeScreenshot} disabled={isBlank || savingAction != null}>
                <Icon name="image" size={14} />
                Take Screenshot
              </button>
              <button type="button" role="menuitem" onClick={() => reload(true)} disabled={isBlank}>
                <Icon name="reload" size={14} />
                Hard Reload
              </button>
              <button type="button" role="menuitem" onClick={copyCurrentUrl} disabled={isBlank}>
                <Icon name="copy" size={14} />
                Copy URL
              </button>
              <button type="button" role="menuitem" onClick={openCurrentExternally} disabled={isBlank || !isHttpLikeUrl(currentUrl)}>
                <Icon name="external-link" size={14} />
                Open in Browser
              </button>
              <span className="db-menu-separator" />
              <button type="button" role="menuitem" onClick={savePageBrief} disabled={isBlank || savingAction != null}>
                <Icon name="file" size={14} />
                Save Page Brief
              </button>
              <button type="button" role="menuitem" onClick={() => saveHarnessTask()} disabled={isBlank || savingAction != null}>
                <Icon name="sparkles" size={14} />
                Browser Harness Task
              </button>
              <span className="db-menu-separator" />
              <button type="button" role="menuitem" onClick={clearHistoryOnly}>
                <Icon name="history" size={14} />
                Clear Browsing History
              </button>
              <button type="button" role="menuitem" onClick={() => void clearCookies(false)}>
                <Icon name="trash" size={14} />
                Clear Cookies
              </button>
              <button type="button" role="menuitem" onClick={() => void clearCookies(true)}>
                <Icon name="trash" size={14} />
                Clear All Data
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {statusMessage ? <div className="db-status">{statusMessage}</div> : null}
      <div className="db-content">
        {isBlank ? (
          <DesignBrowserStart
            onNavigate={navigateTo}
            onSaveHarnessTask={saveHarnessTask}
            savingTask={savingAction === 'task'}
          />
        ) : desktopHostAvailable ? (
          <webview
            ref={assignWebviewNode}
            className="db-webview"
            src={loadUrl}
            partition={DESIGN_BROWSER_PARTITION}
            title={pageTitle}
          />
        ) : (
          <div className="db-fallback">
            <iframe title={pageTitle} src={loadUrl} />
            <div className="db-fallback-bar">
              <span>Embedded browser controls are available in the desktop app.</span>
              <button type="button" onClick={openCurrentExternally}>
                <Icon name="external-link" size={14} />
                Open
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function DesignBrowserStart({
  onNavigate,
  onSaveHarnessTask,
  savingTask,
}: {
  onNavigate: (url: string) => void;
  onSaveHarnessTask: (url: string) => Promise<void>;
  savingTask: boolean;
}) {
  return (
    <div className="db-start">
      <div className="db-start-hero">
        <div>
          <div className="db-kicker">Open Design browser</div>
          <h2>Reference, extract, apply.</h2>
        </div>
        <div className="db-agent-card">
          <div className="db-agent-card-title">
            <Icon name="sparkles" size={15} />
            Browser Harness
          </div>
          <p>Turn any opened reference into a saved extraction task for browser-use and artifacts.</p>
        </div>
      </div>
      <div className="db-reference-grid">
        {REFERENCE_GROUPS.map((group) => (
          <section key={group.title} className="db-reference-group">
            <h3>{group.title}</h3>
            <div className="db-reference-list">
              {group.sites.map((site) => (
                <article key={site.url} className="db-reference-card">
                  <button type="button" onClick={() => onNavigate(site.url)}>
                    <span>{site.label}</span>
                    <small>{new URL(site.url).hostname.replace(/^www\./, '')}</small>
                  </button>
                  <p>{site.detail}</p>
                  <div className="db-reference-actions">
                    <button type="button" onClick={() => onNavigate(site.url)}>
                      <Icon name="globe" size={13} />
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => void onSaveHarnessTask(site.url)}
                      disabled={savingTask}
                    >
                      <Icon name="sparkles" size={13} />
                      Task
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export function loadHistory(projectId: string): BrowserHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(historyStorageKey(projectId));
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isHistoryEntry)
      .sort((left, right) => right.lastVisitedAt - left.lastVisitedAt)
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function saveHistory(projectId: string, history: BrowserHistoryEntry[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(historyStorageKey(projectId), JSON.stringify(history.slice(0, HISTORY_LIMIT)));
  } catch {
    // Ignore storage quota and private-mode failures.
  }
}

function historyStorageKey(projectId: string): string {
  return `od:design-browser:${projectId}:history:v1`;
}

export function isHistoryEntry(value: unknown): value is BrowserHistoryEntry {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.url === 'string' &&
    typeof record.title === 'string' &&
    typeof record.lastVisitedAt === 'number' &&
    typeof record.visitCount === 'number'
  );
}

export function normalizeBrowserAddress(rawAddress: string): string {
  const value = rawAddress.trim();
  if (!value) return EMPTY_URL;
  if (value === EMPTY_URL) return EMPTY_URL;
  if (/^(https?|file):\/\//i.test(value)) return value;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(value)) return `http://${value}`;
  if (/^(127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(value)) return `http://${value}`;
  if (value.startsWith('/')) {
    if (/^\/(api|artifacts|frames)(\/|$)/.test(value) && typeof window !== 'undefined') {
      return new URL(value, window.location.origin).toString();
    }
    return `file://${encodeURI(value)}`;
  }
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

export function labelFromUrl(url: string): string {
  if (url === EMPTY_URL) return 'New Tab';
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

export function isHistoryUrl(url: string): boolean {
  return url !== EMPTY_URL && (isHttpLikeUrl(url) || /^file:\/\//i.test(url));
}

function isHttpLikeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function sameUrl(left: string, right: string): boolean {
  return left.replace(/\/+$/, '') === right.replace(/\/+$/, '');
}

function safeGetWebviewUrl(node: WebviewElement): string {
  try {
    return node.getURL();
  } catch {
    return '';
  }
}

function safeGetWebviewTitle(node: WebviewElement): string {
  try {
    return node.getTitle();
  } catch {
    return '';
  }
}

export function browserFileName(prefix: string, url: string, extension: 'md' | 'png'): string {
  const host = labelFromUrl(url).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'page';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `browser/${prefix}-${host}-${stamp}.${extension}`;
}

export function pageBriefMarkdown(brief: PageBrief, fallbackUrl: string): string {
  const title = brief.title || labelFromUrl(fallbackUrl);
  const url = brief.url || fallbackUrl;
  const lines = [
    `# ${title}`,
    '',
    `Source: ${url}`,
    '',
  ];
  if (brief.description) {
    lines.push('## Description', '', brief.description, '');
  }
  appendList(lines, 'Headings', brief.headings);
  appendList(lines, 'Images', brief.images);
  appendList(lines, 'Links', brief.links?.map((link) => `${link.text} - ${link.url}`));
  appendList(lines, 'Colors', brief.colors?.map((color) => `${color.value} (${color.count})`));
  lines.push('## Browser Harness follow-up', '', browserHarnessTaskMarkdown('', url).trim(), '');
  return `${lines.join('\n').trim()}\n`;
}

function appendList(lines: string[], title: string, values?: string[]) {
  const filtered = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (filtered.length === 0) return;
  lines.push(`## ${title}`, '');
  for (const value of filtered) lines.push(`- ${value}`);
  lines.push('');
}

export function browserHarnessTaskMarkdown(projectId: string, url: string): string {
  const projectLine = projectId ? `Open Design project: ${projectId}` : 'Open Design project: current project';
  return `# Browser Harness Design Extraction

Target URL: ${url}
${projectLine}

## Goal

Use browser-use/browser-harness to inspect the target page, extract the design language, and produce reusable Open Design artifacts.

## Capture

- Key screenshots for desktop and mobile.
- Typography, color palette, spacing rhythm, interaction and motion notes.
- Useful public assets, links, and implementation references.
- A concise design brief that can guide the next artifact iteration.

## Suggested command

\`\`\`bash
browser-harness <<'PY'
new_tab("${url}")
wait_for_load()
capture_screenshot(path="reference.png", full_page=True)
print(page_info())
print(js("""(() => ({
  title: document.title,
  headings: Array.from(document.querySelectorAll('h1,h2,h3')).map((node) => node.textContent.trim()).filter(Boolean).slice(0, 20),
  colors: Array.from(new Set(Array.from(document.querySelectorAll('body,body *')).slice(0, 500).flatMap((node) => {
    const style = getComputedStyle(node);
    return [style.color, style.backgroundColor, style.borderColor].filter((value) => value && value !== 'rgba(0, 0, 0, 0)');
  }))).slice(0, 20)
}))()"""))
PY
\`\`\`
`;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fall back for desktop/web contexts where clipboard permission is blocked.
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    textarea.remove();
  }
}
