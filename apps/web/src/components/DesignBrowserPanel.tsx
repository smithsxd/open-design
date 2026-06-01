import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type ReactNode,
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
import { captureHostRegionSnapshot } from '../runtime/exports';
import { Icon } from './Icon';
import { PreviewDrawOverlay } from './PreviewDrawOverlay';

type BrowserHistoryEntry = {
  iconUrl?: string;
  title: string;
  url: string;
  lastVisitedAt: number;
  visitCount: number;
};

type BrowserNavigationEntry = {
  title: string;
  url: string;
};

type ReferenceSite = {
  label: string;
  url: string;
  detail: string;
};

type ReferenceGroup = {
  /** Stable key used for the category filter (lowercase, no spaces). */
  id: string;
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
  loadURL?(url: string): void | Promise<void>;
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

type WebviewFaviconEvent = Event & {
  favicons?: string[];
};

interface DesignBrowserPanelProps {
  initialIconUrl?: string;
  initialTitle?: string;
  initialUrl?: string;
  projectId: string;
  onOpenFile: (name: string) => void;
  onRefreshFiles: () => Promise<void> | void;
  onPageInfoChange?: (info: BrowserPageInfo) => void;
  sendDisabled?: boolean;
}

export interface BrowserPageInfo {
  iconUrl?: string;
  title: string;
  url: string;
}

const EMPTY_URL = 'about:blank';
const DESIGN_BROWSER_PARTITION = 'persist:open-design-design-browser';
const HISTORY_LIMIT = 80;
const HISTORY_SUGGESTION_LIMIT = 20;
const warmedOrigins = new Set<string>();

function initialBrowserState(initialUrl?: string, initialTitle?: string): {
  addressValue: string;
  navigationIndex: number;
  navigationStack: BrowserNavigationEntry[];
  url: string;
} {
  const url = initialUrl?.trim() && isHistoryUrl(initialUrl.trim())
    ? initialUrl.trim()
    : EMPTY_URL;
  if (url === EMPTY_URL) {
    return {
      addressValue: '',
      navigationIndex: -1,
      navigationStack: [],
      url,
    };
  }
  const title = initialTitle?.trim() || labelFromUrl(url);
  return {
    addressValue: url,
    navigationIndex: 0,
    navigationStack: [{ title, url }],
    url,
  };
}

// The Reference Board catalogue. Order is intentional: the categories a working
// designer reaches for most often (inspiration, real product UI) lead, followed
// by motion/color/type/asset references, then systems/guidelines/tooling.
// Adding a group here automatically adds its filter chip and address-bar
// suggestions — `id` is the stable filter key, `title` is the display label.
export const REFERENCE_GROUPS: ReferenceGroup[] = [
  {
    id: 'inspiration',
    title: 'Inspiration',
    sites: [
      { label: 'Dribbble', url: 'https://dribbble.com/', detail: 'Design shots and UI inspiration.' },
      { label: 'Behance', url: 'https://www.behance.net/', detail: 'Creative portfolios and case studies.' },
      { label: 'Awwwards', url: 'https://www.awwwards.com/', detail: 'Award-winning website design.' },
      { label: 'Godly', url: 'https://godly.website/', detail: 'Curated modern web design.' },
      { label: 'Land-book', url: 'https://land-book.com/', detail: 'Landing page gallery and patterns.' },
    ],
  },
  {
    id: 'interfaces',
    title: 'Real Interfaces',
    sites: [
      { label: 'Mobbin', url: 'https://mobbin.com/', detail: 'Real app screens and UI patterns.' },
      { label: 'Screenlane', url: 'https://screenlane.com/', detail: 'Latest UI design patterns from apps.' },
      { label: 'Page Flows', url: 'https://pageflows.com/', detail: 'Real product user flows and onboarding.' },
      { label: 'UI Sources', url: 'https://www.uisources.com/', detail: 'Interaction patterns from top apps.' },
      { label: 'Collect UI', url: 'https://collectui.com/', detail: 'Daily UI collection by category.' },
    ],
  },
  {
    id: 'motion',
    title: 'Motion',
    sites: [
      { label: 'GSAP', url: 'https://gsap.com/', detail: 'Production animation engine and examples.' },
      { label: 'Animations.dev', url: 'https://animations.dev/', detail: 'Animation patterns and interaction examples.' },
      { label: 'Transitions', url: 'https://transitions.dev/', detail: 'Transition patterns for modern interfaces.' },
      { label: 'Motion Sites', url: 'https://motionsites.ai/', detail: 'High-end motion and interaction references.' },
      { label: 'Motion.page Showcase', url: 'https://motion.page/showcase/', detail: 'Scroll and timeline animation inspiration.' },
      { label: 'Animography', url: 'https://animography.net/', detail: 'Animated type and kinetic lettering.' },
    ],
  },
  {
    id: 'color',
    title: 'Color',
    sites: [
      { label: 'Coolors', url: 'https://coolors.co/', detail: 'Fast color palette generator.' },
      { label: 'Color Hunt', url: 'https://colorhunt.co/', detail: 'Curated color palettes.' },
      { label: 'Realtime Colors', url: 'https://www.realtimecolors.com/', detail: 'Preview palettes on a real UI.' },
      { label: 'Adobe Color', url: 'https://color.adobe.com/', detail: 'Color wheel and harmony rules.' },
      { label: 'Happy Hues', url: 'https://www.happyhues.co/', detail: 'Palettes shown in real context.' },
    ],
  },
  {
    id: 'type',
    title: 'Typography',
    sites: [
      { label: 'Google Fonts', url: 'https://fonts.google.com/', detail: 'Open-source font library.' },
      { label: 'Fontshare', url: 'https://www.fontshare.com/', detail: 'Quality fonts free for commercial use.' },
      { label: 'Typewolf', url: 'https://www.typewolf.com/', detail: 'Fonts in use and pairing guidance.' },
      { label: 'Fontpair', url: 'https://www.fontpair.co/', detail: 'Font pairing suggestions.' },
      { label: 'Fonts In Use', url: 'https://fontsinuse.com/', detail: 'Typography in real-world design.' },
    ],
  },
  {
    id: 'icons',
    title: 'Icons',
    sites: [
      { label: 'The SVG', url: 'https://thesvg.org/', detail: 'SVG assets and vector references.' },
      { label: 'SVG Logos', url: 'https://svglogos.dev/', detail: 'Clean SVG logos for product and brand mocks.' },
      { label: 'Lobe Icons', url: 'https://icons.lobehub.com/', detail: 'Product and AI-brand icons for interfaces.' },
      { label: 'Iconify', url: 'https://icon-sets.iconify.design/', detail: '200k+ open-source icons in one place.' },
      { label: 'Lucide', url: 'https://lucide.dev/', detail: 'Clean, consistent open icon set.' },
      { label: 'Heroicons', url: 'https://heroicons.com/', detail: 'Tailwind-made SVG icons.' },
      { label: 'SVG Repo', url: 'https://www.svgrepo.com/', detail: 'Free SVG vectors and icons.' },
    ],
  },
  {
    id: 'illustration',
    title: 'Illustration',
    sites: [
      { label: 'Storyset', url: 'https://storyset.com/', detail: 'Customizable vector illustrations.' },
      { label: 'unDraw', url: 'https://undraw.co/', detail: 'Open-source MIT illustrations.' },
      { label: 'Blush', url: 'https://blush.design/', detail: 'Mix-and-match illustrations.' },
      { label: 'Lummi', url: 'https://www.lummi.ai/', detail: 'Free AI-generated visuals.' },
      { label: 'Whirrls', url: 'https://www.whirrls.com/', detail: 'Hand-drawn image references.' },
      { label: 'World in Dots', url: 'https://www.worldindots.com/', detail: 'Dot-map and data-viz references.' },
    ],
  },
  {
    id: 'photography',
    title: 'Photography',
    sites: [
      { label: 'Unsplash', url: 'https://unsplash.com/', detail: 'Free high-resolution photos.' },
      { label: 'Pexels', url: 'https://www.pexels.com/', detail: 'Free stock photos and video.' },
      { label: 'Pixabay', url: 'https://pixabay.com/', detail: 'Royalty-free images and media.' },
      { label: 'Cosmos', url: 'https://www.cosmos.so/', detail: 'Visual discovery and mood boards.' },
    ],
  },
  {
    id: '3d',
    title: '3D & Graphics',
    sites: [
      { label: 'Spline', url: 'https://spline.design/', detail: 'Browser-based 3D design.' },
      { label: 'Three.js Examples', url: 'https://threejs.org/examples/', detail: 'WebGL 3D references and demos.' },
      { label: 'Womp', url: 'https://womp.com/', detail: 'Easy in-browser 3D creation.' },
      { label: 'Pixcap', url: 'https://pixcap.com/', detail: '3D icons, mockups, and scenes.' },
    ],
  },
  {
    id: 'mockups',
    title: 'Mockups',
    sites: [
      { label: 'Shots', url: 'https://shots.so/', detail: 'Device and browser mockups.' },
      { label: 'Mockuuups Studio', url: 'https://mockuuups.studio/', detail: 'Drag-and-drop device mockups.' },
      { label: 'Angle', url: 'https://angle.sh/', detail: '3D device mockup library.' },
      { label: 'Rotato', url: 'https://rotato.app/', detail: 'Animated 3D product mockups.' },
    ],
  },
  {
    id: 'systems',
    title: 'Design Systems',
    sites: [
      { label: 'Impeccable Style', url: 'https://impeccable.style/', detail: 'High-quality style and interface references.' },
      { label: 'Styles Refero', url: 'https://styles.refero.design/', detail: 'Design style references and visual systems.' },
      { label: 'Brandfetch', url: 'https://brandfetch.com/', detail: 'Brand assets, logos, and identity.' },
      { label: 'Design Systems Repo', url: 'https://designsystemsrepo.com/', detail: 'Gallery of public design systems.' },
      { label: 'Startups Gallery', url: 'https://startups.gallery/', detail: 'Top startup product and brand references.' },
    ],
  },
  {
    id: 'components',
    title: 'Components',
    sites: [
      { label: 'Base UI', url: 'https://base-ui.com/', detail: 'Unstyled accessible primitives for custom systems.' },
      { label: 'shadcn/ui', url: 'https://ui.shadcn.com/', detail: 'Composable React components built on Radix and Tailwind.' },
      { label: 'HeroUI', url: 'https://www.heroui.com/', detail: 'Modern React component library and design system.' },
      { label: 'Radix UI', url: 'https://www.radix-ui.com/', detail: 'Accessible low-level UI primitives.' },
      { label: 'React Aria', url: 'https://react-spectrum.adobe.com/react-aria/', detail: 'Accessible behavior primitives from Adobe.' },
      { label: 'Headless UI', url: 'https://headlessui.com/', detail: 'Unstyled accessible components for Tailwind projects.' },
      { label: 'MUI', url: 'https://mui.com/', detail: 'Material-based React component ecosystem.' },
      { label: 'Mantine', url: 'https://mantine.dev/', detail: 'Full-featured React components and hooks.' },
      { label: 'Chakra UI', url: 'https://chakra-ui.com/', detail: 'Accessible React components with theme tokens.' },
      { label: 'Ant Design', url: 'https://ant.design/', detail: 'Enterprise component system and patterns.' },
      { label: 'Ark UI', url: 'https://ark-ui.com/', detail: 'Headless components across modern frameworks.' },
      { label: 'daisyUI', url: 'https://daisyui.com/', detail: 'Tailwind CSS component classes and themes.' },
    ],
  },
  {
    id: 'guidelines',
    title: 'Guidelines & A11y',
    sites: [
      { label: 'Apple HIG', url: 'https://developer.apple.com/design/human-interface-guidelines', detail: 'Apple platform design guidelines.' },
      { label: 'Material Design', url: 'https://m3.material.io/', detail: "Google's Material Design 3." },
      { label: 'Laws of UX', url: 'https://lawsofux.com/', detail: 'UX principles and heuristics.' },
      { label: 'WebAIM Contrast', url: 'https://webaim.org/resources/contrastchecker/', detail: 'Color contrast checker.' },
      { label: 'The A11y Project', url: 'https://www.a11yproject.com/', detail: 'Accessibility checklist and patterns.' },
    ],
  },
  {
    id: 'tools',
    title: 'Tools & Resources',
    sites: [
      { label: 'Toolfolio', url: 'https://toolfolio.io/', detail: 'Design tools, resources, and collections.' },
      { label: 'GetDesign', url: 'https://getdesign.md/', detail: 'Curated design resources.' },
      { label: 'Taste Skill', url: 'https://www.tasteskill.dev/', detail: 'Design taste training and critique references.' },
      { label: 'UI Goodies', url: 'https://www.uigoodies.com/', detail: 'Hand-picked design resources.' },
      { label: 'Sidebar', url: 'https://sidebar.io/', detail: 'Five design links, every day.' },
      { label: 'Browser Harness', url: 'https://github.com/browser-use/browser-harness', detail: 'Browser automation harness for extraction tasks.' },
      { label: 'Superset', url: 'https://github.com/superset-sh/superset', detail: 'Reference implementation for embedded browser workflows.' },
    ],
  },
];

/** Total number of curated references across every category (drives the "All" chip badge). */
export const REFERENCE_TOTAL = REFERENCE_GROUPS.reduce((sum, group) => sum + group.sites.length, 0);

/**
 * Filter the reference catalogue by an active category and a free-text query.
 *
 * `category` is either the sentinel `'all'` or a {@link ReferenceGroup.id}. The
 * query matches a site's label, hostname, or detail, OR the owning group's
 * title (so searching "color" surfaces the whole Color group). Groups with no
 * surviving sites are dropped, so the result is always ready to render as-is.
 */
export function filterReferenceGroups(
  groups: ReferenceGroup[],
  category: string,
  query: string,
): ReferenceGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  return groups
    .filter((group) => category === 'all' || group.id === category)
    .map((group) => {
      if (!needle) return group;
      if (group.title.toLocaleLowerCase().includes(needle)) return group;
      const sites = group.sites.filter(
        (site) =>
          site.label.toLocaleLowerCase().includes(needle) ||
          site.detail.toLocaleLowerCase().includes(needle) ||
          hostnameFromUrl(site.url).toLocaleLowerCase().includes(needle),
      );
      return { ...group, sites };
    })
    .filter((group) => group.sites.length > 0);
}

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
  initialIconUrl,
  initialTitle,
  initialUrl,
  projectId,
  onOpenFile,
  onPageInfoChange,
  onRefreshFiles,
  sendDisabled = false,
}: DesignBrowserPanelProps) {
  const desktopHostAvailable = isOpenDesignHostAvailable();
  const initialState = initialBrowserState(initialUrl, initialTitle);
  // `loadUrl` is the navigation target bound to the <webview>/<iframe> `src`.
  // It changes ONLY on user-initiated navigation. `currentUrl` is the committed
  // location shown in the address bar and recorded in history, synced from the
  // webview's own navigation events. They are deliberately separate: if `src`
  // tracked every committed URL, a server redirect (e.g. adding a trailing
  // slash) would mutate `src` mid-load and Electron would abort the in-flight
  // navigation (ERR_ABORTED -3), leaving the page blank.
  const [loadUrl, setLoadUrl] = useState(initialState.url);
  const [currentUrl, setCurrentUrl] = useState(initialState.url);
  const [addressValue, setAddressValue] = useState(initialState.addressValue);
  const [addressEditing, setAddressEditing] = useState(false);
  const [history, setHistory] = useState<BrowserHistoryEntry[]>(() => loadHistory(projectId));
  const [navigationStack, setNavigationStack] = useState<BrowserNavigationEntry[]>(initialState.navigationStack);
  const [navigationIndex, setNavigationIndex] = useState(initialState.navigationIndex);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [webviewNode, setWebviewNode] = useState<WebviewElement | null>(null);
  const [drawOverlayOpen, setDrawOverlayOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [savingAction, setSavingAction] = useState<'brief' | 'screenshot' | 'task' | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const restoredIconUrlRef = useRef(initialIconUrl?.trim() ?? '');
  const restoredTitleRef = useRef(initialTitle?.trim() ?? '');
  const navigationStackRef = useRef<BrowserNavigationEntry[]>(initialState.navigationStack);
  const navigationIndexRef = useRef(initialState.navigationIndex);
  const pendingLoadTargetRef = useRef<string | null>(null);
  const canGoBack = navigationIndex > 0;
  const canGoForward = navigationIndex >= 0 && navigationIndex < navigationStack.length - 1;
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
    const nextInitialState = initialBrowserState(initialUrl, initialTitle);
    setLoadUrl(nextInitialState.url);
    setCurrentUrl(nextInitialState.url);
    setAddressValue(nextInitialState.addressValue);
    setAddressEditing(false);
    setNavigationStack(nextInitialState.navigationStack);
    setNavigationIndex(nextInitialState.navigationIndex);
    navigationStackRef.current = nextInitialState.navigationStack;
    navigationIndexRef.current = nextInitialState.navigationIndex;
    pendingLoadTargetRef.current = null;
    if (isHistoryUrl(nextInitialState.url)) {
      commitHistory(
        nextInitialState.url,
        { iconUrl: initialIconUrl, title: initialTitle },
        { countVisit: false },
      );
    }
    // `initial*` props are mount-time tab restore inputs. During normal
    // navigation the parent updates them from onPageInfoChange; that must not
    // reset the live webview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => saveHistory(projectId, history), 140);
    return () => window.clearTimeout(timer);
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

  const commitHistory = useCallback((url: string, meta: { title?: string; iconUrl?: string } = {}, options: { countVisit?: boolean } = {}) => {
    if (!isHistoryUrl(url)) return;
    setHistory((current) => {
      const now = Date.now();
      const existing = current.find((entry) => sameUrl(entry.url, url));
      const nextTitle = meta.title && meta.title.trim()
        ? meta.title.trim()
        : existing?.title || labelFromUrl(url);
      const nextIconUrl = cleanIconUrl(meta.iconUrl) || existing?.iconUrl || faviconUrl(url);
      const visitIncrement = options.countVisit === false ? 0 : 1;
      const entry = existing
        ? {
            ...existing,
            iconUrl: nextIconUrl,
            title: nextTitle,
            lastVisitedAt: visitIncrement > 0 ? now : existing.lastVisitedAt,
            visitCount: existing.visitCount + visitIncrement,
          }
        : { iconUrl: nextIconUrl, title: nextTitle, url, lastVisitedAt: now, visitCount: 1 };
      if (
        existing &&
        existing.title === entry.title &&
        existing.iconUrl === entry.iconUrl &&
        existing.lastVisitedAt === entry.lastVisitedAt &&
        existing.visitCount === entry.visitCount
      ) {
        return current;
      }
      return [entry, ...current.filter((item) => !sameUrl(item.url, url))]
        .slice(0, HISTORY_LIMIT);
    });
  }, []);

  const setNavigationState = useCallback((stack: BrowserNavigationEntry[], index: number) => {
    navigationStackRef.current = stack;
    navigationIndexRef.current = index;
    setNavigationStack(stack);
    setNavigationIndex(index);
  }, []);

  const recordNavigation = useCallback((url: string, title?: string, options?: { replacePendingTarget?: boolean }) => {
    if (url === EMPTY_URL) {
      pendingLoadTargetRef.current = null;
      setNavigationState([], -1);
      return;
    }
    if (!isHistoryUrl(url)) return;

    const stack = navigationStackRef.current;
    const index = navigationIndexRef.current;
    const nextTitle = title && title.trim() ? title.trim() : labelFromUrl(url);
    const nextEntry: BrowserNavigationEntry = { title: nextTitle, url };
    const updateEntry = (entries: BrowserNavigationEntry[], entryIndex: number) => {
      const existing = entries[entryIndex];
      const next = entries.slice();
      next[entryIndex] = {
        title: nextTitle || existing?.title || labelFromUrl(url),
        url,
      };
      return next;
    };
    const currentEntry = index >= 0 ? stack[index] : undefined;
    const pendingTarget = pendingLoadTargetRef.current;
    const shouldReplacePending =
      Boolean(options?.replacePendingTarget && pendingTarget && currentEntry && sameUrl(currentEntry.url, pendingTarget));

    if (currentEntry && (sameUrl(currentEntry.url, url) || shouldReplacePending)) {
      setNavigationState(updateEntry(stack, index), index);
      if (options?.replacePendingTarget) pendingLoadTargetRef.current = null;
      return;
    }

    const previousIndex = index - 1;
    if (previousIndex >= 0 && sameUrl(stack[previousIndex]?.url ?? '', url)) {
      setNavigationState(updateEntry(stack, previousIndex), previousIndex);
      if (options?.replacePendingTarget) pendingLoadTargetRef.current = null;
      return;
    }

    const nextIndex = index + 1;
    if (nextIndex < stack.length && sameUrl(stack[nextIndex]?.url ?? '', url)) {
      setNavigationState(updateEntry(stack, nextIndex), nextIndex);
      if (options?.replacePendingTarget) pendingLoadTargetRef.current = null;
      return;
    }

    const base = index >= 0 ? stack.slice(0, index + 1) : [];
    const nextStack = [...base, nextEntry].slice(-HISTORY_LIMIT);
    setNavigationState(nextStack, nextStack.length - 1);
    if (options?.replacePendingTarget) pendingLoadTargetRef.current = null;
  }, [setNavigationState]);

  const updateCurrentNavigationTitle = useCallback((title?: string) => {
    const trimmedTitle = title?.trim();
    const index = navigationIndexRef.current;
    if (!trimmedTitle || index < 0) return;
    const stack = navigationStackRef.current;
    const currentEntry = stack[index];
    if (!currentEntry || currentEntry.title === trimmedTitle) return;
    const nextStack = stack.slice();
    nextStack[index] = { ...currentEntry, title: trimmedTitle };
    setNavigationState(nextStack, index);
  }, [setNavigationState]);

  const loadWebviewUrl = useCallback((url: string) => {
    if (!webviewNode) {
      setLoadUrl(url);
      return;
    }
    if (loadUrl === EMPTY_URL) {
      setLoadUrl(url);
      return;
    }
    try {
      const result = webviewNode.loadURL?.(url);
      if (result instanceof Promise) void result.catch(() => setLoadUrl(url));
      else if (!webviewNode.loadURL) setLoadUrl(url);
    } catch {
      setLoadUrl(url);
    }
  }, [loadUrl, webviewNode]);

  const navigateTo = useCallback((rawAddress: string) => {
    const nextUrl = normalizeBrowserAddress(rawAddress);
    warmBrowserOrigin(nextUrl);
    pendingLoadTargetRef.current = isHistoryUrl(nextUrl) ? nextUrl : null;
    setCurrentUrl(nextUrl);
    setAddressValue(nextUrl === EMPTY_URL ? '' : nextUrl);
    setAddressEditing(false);
    setSuggestionsOpen(false);
    setMenuOpen(false);
    if (isHistoryUrl(nextUrl)) {
      commitHistory(nextUrl, undefined, { countVisit: true });
      recordNavigation(nextUrl);
    } else if (nextUrl === EMPTY_URL) {
      setLoadUrl(EMPTY_URL);
      recordNavigation(nextUrl);
    }
    if (nextUrl !== EMPTY_URL) loadWebviewUrl(nextUrl);
  }, [commitHistory, loadWebviewUrl, recordNavigation]);

  const updateLoadingState = useCallback((node: WebviewElement | null = webviewNode) => {
    if (!node) {
      setIsLoading(false);
      return;
    }
    // Electron's <webview> throws ("The WebView must be attached to the DOM and
    // the dom-ready event emitted before this method can be called") when
    // isLoading runs before the guest attaches. The mount effect calls this
    // immediately, so guard like safeGetWebviewUrl/Title do.
    try {
      setIsLoading(Boolean(node.isLoading()));
    } catch {
      // Pre-dom-ready: keep the existing loading state.
    }
  }, [webviewNode]);

  useEffect(() => {
    const node = webviewNode;
    if (!node) return;

    const syncFromWebview = (
      url?: string,
      title?: string,
      options?: { iconUrl?: string; recordNavigation?: boolean; recordVisit?: boolean },
    ) => {
      const nextUrl = url || safeGetWebviewUrl(node);
      if (nextUrl) {
        setCurrentUrl(nextUrl);
        if (!addressEditing) {
          setAddressValue(nextUrl === EMPTY_URL ? '' : nextUrl);
        }
      }
      const nextTitle = title || safeGetWebviewTitle(node);
      if (nextUrl) {
        commitHistory(nextUrl, { iconUrl: options?.iconUrl, title: nextTitle }, { countVisit: options?.recordVisit === true });
        if (options?.recordNavigation !== false) {
          recordNavigation(nextUrl, nextTitle, { replacePendingTarget: true });
        } else {
          updateCurrentNavigationTitle(nextTitle);
        }
      }
      updateLoadingState(node);
    };
    const onStart = () => {
      setIsLoading(true);
      updateLoadingState(node);
    };
    const onStop = () => {
      setIsLoading(false);
      syncFromWebview(undefined, undefined, { recordVisit: false });
    };
    const onNavigate = (event: Event) => {
      const navigationEvent = event as WebviewNavigationEvent;
      if (navigationEvent.isMainFrame === false) return;
      const pendingTarget = pendingLoadTargetRef.current;
      const nextUrl = navigationEvent.url || safeGetWebviewUrl(node);
      const isPendingCommit = Boolean(pendingTarget && nextUrl && sameUrl(pendingTarget, nextUrl));
      syncFromWebview(nextUrl, undefined, { recordVisit: !isPendingCommit });
    };
    const onTitle = (event: Event) => {
      const titleEvent = event as WebviewTitleEvent;
      syncFromWebview(undefined, titleEvent.title, { recordNavigation: false, recordVisit: false });
    };
    const onFavicon = (event: Event) => {
      const faviconEvent = event as WebviewFaviconEvent;
      const iconUrl = faviconEvent.favicons?.find(isHttpLikeUrl);
      if (!iconUrl) return;
      syncFromWebview(undefined, undefined, { iconUrl, recordNavigation: false, recordVisit: false });
    };
    const onFail = (event: Event) => {
      const navigationEvent = event as WebviewNavigationEvent;
      if (navigationEvent.isMainFrame === false) return;
      setIsLoading(false);
      pendingLoadTargetRef.current = null;
      updateLoadingState(node);
    };

    node.addEventListener('did-start-loading', onStart);
    node.addEventListener('did-stop-loading', onStop);
    node.addEventListener('did-navigate', onNavigate);
    node.addEventListener('did-navigate-in-page', onNavigate);
    node.addEventListener('page-title-updated', onTitle);
    node.addEventListener('page-favicon-updated', onFavicon);
    node.addEventListener('did-fail-load', onFail);
    node.addEventListener('dom-ready', onStop);
    updateLoadingState(node);
    return () => {
      node.removeEventListener('did-start-loading', onStart);
      node.removeEventListener('did-stop-loading', onStop);
      node.removeEventListener('did-navigate', onNavigate);
      node.removeEventListener('did-navigate-in-page', onNavigate);
      node.removeEventListener('page-title-updated', onTitle);
      node.removeEventListener('page-favicon-updated', onFavicon);
      node.removeEventListener('did-fail-load', onFail);
      node.removeEventListener('dom-ready', onStop);
    };
  }, [addressEditing, commitHistory, recordNavigation, updateCurrentNavigationTitle, updateLoadingState, webviewNode]);

  const suggestions = useMemo(() => {
    const query = addressValue.trim().toLocaleLowerCase();
    const showDefaultSuggestions = addressEditing && currentUrl !== EMPTY_URL && sameUrl(addressValue.trim(), currentUrl);
    const referenceSuggestions = REFERENCE_GROUPS.flatMap((group) =>
      group.sites.map((site) => ({
        detail: `${group.title} - ${site.detail}`,
        id: `site:${site.url}`,
        iconUrl: referenceIconUrl(site.url),
        label: site.label,
        type: 'Reference' as const,
        url: site.url,
      })),
    );
    const historySuggestions = history.slice(0, HISTORY_SUGGESTION_LIMIT).map((entry) => ({
      detail: entry.url,
      id: `history:${entry.url}`,
      iconUrl: entry.iconUrl || faviconUrl(entry.url),
      label: entry.title || labelFromUrl(entry.url),
      type: 'History' as const,
      url: entry.url,
    }));
    const all = [...historySuggestions, ...referenceSuggestions];
    if (!query || showDefaultSuggestions) return all;
    return all
      .filter((item) =>
        `${item.label} ${item.url} ${item.detail}`.toLocaleLowerCase().includes(query),
      )
      .slice(0, HISTORY_SUGGESTION_LIMIT + referenceSuggestions.length);
  }, [addressEditing, addressValue, currentUrl, history]);

  const pageHistoryEntry = history.find((entry) => sameUrl(entry.url, currentUrl));
  const pageTitle = pageHistoryEntry?.title || restoredTitleRef.current || labelFromUrl(currentUrl);
  const pageIconUrl = pageHistoryEntry?.iconUrl || restoredIconUrlRef.current || faviconUrl(currentUrl);
  const addressDisplayParts = addressEditing
    ? { url: '' }
    : formatAddressDisplayParts(currentUrl, pageTitle);
  const shownAddressValue = addressEditing ? addressValue : '';
  // Drive the start-page/webview branch off the load target, not the committed
  // URL, so a transient about:blank navigation event can't unmount the webview.
  const isBlank = loadUrl === EMPTY_URL;

  useEffect(() => {
    onPageInfoChange?.({
      title: isBlank ? 'Browser' : pageTitle,
      url: isBlank ? '' : currentUrl,
      ...(!isBlank && pageIconUrl ? { iconUrl: pageIconUrl } : {}),
    });
  }, [currentUrl, isBlank, onPageInfoChange, pageIconUrl, pageTitle]);

  async function handleAddressSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigateTo(addressValue);
    addressInputRef.current?.blur();
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
    // Close the dropdown first so it cannot appear in a host compositor capture
    // (which screenshots the on-screen window region, not the guest surface).
    setMenuOpen(false);
    try {
      // Let the dropdown unmount + repaint before the compositor capture.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const dataUrl = await captureBrowserPageDataUrl();
      if (!dataUrl) throw new Error('screenshot capture failed');
      // Put the capture on the clipboard first so it is paste-ready (e.g. into
      // the chat composer) the instant it is taken; the project file is the
      // durable artifact, the clipboard is the fast path.
      const copied = await copyImageToClipboard(dataUrl);
      const base64 = dataUrl.split(',', 2)[1] ?? '';
      const file = await writeProjectBase64File(
        projectId,
        browserFileName('browser-capture', currentUrl, 'png'),
        base64,
      );
      if (!file) throw new Error('screenshot save failed');
      await onRefreshFiles();
      // Stay on the browser so the confirmation toast is visible and the page
      // remains in view; the capture is reachable from Design Files. Show
      // whether it reached the clipboard so the user knows it is paste-ready.
      setStatusMessage(copied ? 'Screenshot copied to clipboard' : 'Screenshot saved to project');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Screenshot failed');
    } finally {
      setSavingAction(null);
      setMenuOpen(false);
    }
  }

  // Capture the live page as a PNG data URL. Prefers the desktop compositor
  // screenshot of the webview's on-screen region: the embedded <webview> guest
  // WebContents' own capturePage() frequently returns an all-black frame (its
  // GPU surface is not available to that capture path), whereas the host
  // window's composited surface clipped to the webview rect yields the real
  // page pixels the user sees — including authenticated content, since it is
  // the same logged-in session. Falls back to the guest capturePage() only when
  // no desktop host is present.
  async function captureBrowserPageDataUrl(): Promise<string | null> {
    const node = webviewNode;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const hostSnap = await captureHostRegionSnapshot({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
    if (hostSnap) return hostSnap.dataUrl;
    try {
      const image = await node.capturePage();
      return image.toDataURL();
    } catch {
      return null;
    }
  }

  async function captureBrowserSnapshot(): Promise<{ dataUrl: string; w: number; h: number } | null> {
    if (!webviewNode || isBlank) return null;
    const rect = webviewNode.getBoundingClientRect();
    const hostSnap = await captureHostRegionSnapshot({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
    if (hostSnap) return hostSnap;
    try {
      const image = await webviewNode.capturePage();
      const dataUrl = image.toDataURL();
      const size = await imageSizeFromDataUrl(dataUrl);
      if (size) return { dataUrl, ...size };
      const dpr = window.devicePixelRatio || 1;
      return {
        dataUrl,
        w: Math.max(1, Math.round(rect.width * dpr)),
        h: Math.max(1, Math.round(rect.height * dpr)),
      };
    } catch {
      return null;
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
      setAddressEditing(false);
      setNavigationState([], -1);
      pendingLoadTargetRef.current = null;
      saveHistory(projectId, []);
    }
    setMenuOpen(false);
  }

  function clearHistoryOnly() {
    setHistory([]);
    saveHistory(projectId, []);
    setStatusMessage('History cleared');
    setMenuOpen(false);
  }

  function navigateHistoryBy(delta: -1 | 1) {
    const targetIndex = navigationIndex + delta;
    const entry = navigationStack[targetIndex];
    if (!entry) return;
    pendingLoadTargetRef.current = null;
    setNavigationState(navigationStack.slice(), targetIndex);
    setCurrentUrl(entry.url);
    setAddressValue(entry.url);
    setAddressEditing(false);
    setSuggestionsOpen(false);
    setMenuOpen(false);
    if (webviewNode && canUseNativeHistoryNavigation(webviewNode, delta)) {
      if (delta < 0) webviewNode.goBack();
      else webviewNode.goForward();
    } else {
      loadWebviewUrl(entry.url);
    }
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
          <IconTooltipButton
            label="Go Back"
            disabled={!canGoBack}
            onClick={() => navigateHistoryBy(-1)}
          >
            <Icon name="chevron-left" size={16} />
          </IconTooltipButton>
          <IconTooltipButton
            label="Go Forward"
            disabled={!canGoForward}
            onClick={() => navigateHistoryBy(1)}
          >
            <Icon name="chevron-right" size={16} />
          </IconTooltipButton>
          <IconTooltipButton
            label={isLoading ? 'Loading...' : 'Reload'}
            className={isLoading ? 'is-spinning' : ''}
            disabled={isBlank}
            onClick={() => reload(false)}
          >
            <Icon name="reload" size={15} />
          </IconTooltipButton>
        </div>
        <form className="db-address-form" onSubmit={handleAddressSubmit}>
          <BrowserSiteIcon
            className="db-address-site-icon"
            fallback="globe"
            iconUrl={isBlank ? undefined : pageIconUrl}
          />
          <div className="db-address-field">
            <input
              ref={addressInputRef}
              value={shownAddressValue}
              onChange={(event) => {
                setAddressEditing(true);
                setAddressValue(event.target.value);
                setSuggestionsOpen(true);
              }}
              onFocus={(event) => {
                setAddressEditing(true);
                setAddressValue(isBlank ? '' : currentUrl);
                setSuggestionsOpen(true);
                const input = event.currentTarget;
                window.requestAnimationFrame(() => input.select());
              }}
              onBlur={(event) => {
                if (event.currentTarget.form?.contains(event.relatedTarget as Node | null)) return;
                window.setTimeout(() => setAddressEditing(false), 80);
              }}
              placeholder={addressDisplayParts.url ? '' : 'Enter URL or search...'}
              aria-label="Browser address"
              autoComplete="off"
              spellCheck={false}
            />
            {addressDisplayParts.url ? (
              <span className="db-address-display" aria-hidden>
                <span className="db-address-url">{addressDisplayParts.url}</span>
                {addressDisplayParts.title ? (
                  <>
                    <span className="db-address-separator">/</span>
                    <span className="db-address-title">{addressDisplayParts.title}</span>
                  </>
                ) : null}
              </span>
            ) : null}
          </div>
          {suggestionsOpen && suggestions.length > 0 ? (
            <div className="db-suggestions" role="listbox">
              {suggestions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  onFocus={() => warmBrowserOrigin(item.url)}
                  onPointerEnter={() => warmBrowserOrigin(item.url)}
                  onClick={() => navigateTo(item.url)}
                >
                  <span className="db-suggestion-icon">
                    <BrowserSiteIcon
                      fallback={item.type === 'History' ? 'history' : 'globe'}
                      iconUrl={item.iconUrl}
                    />
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
          {desktopHostAvailable ? (
            <IconTooltipButton
              label="Copy screenshot to clipboard"
              disabled={isBlank || savingAction != null}
              onClick={takeScreenshot}
            >
              <Icon name="image" size={15} />
            </IconTooltipButton>
          ) : null}
          {desktopHostAvailable ? (
            <IconTooltipButton
              label="Annotate page"
              disabled={isBlank}
              className={drawOverlayOpen ? 'is-active' : ''}
              onClick={() => setDrawOverlayOpen((open) => !open)}
            >
              <Icon name="pencil" size={15} />
            </IconTooltipButton>
          ) : null}
          <IconTooltipButton
            label="Save page brief"
            disabled={isBlank || savingAction != null}
            onClick={savePageBrief}
          >
            <Icon name="file-code" size={15} />
          </IconTooltipButton>
          <IconTooltipButton
            label="Browser menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Icon name="more-horizontal" size={16} />
          </IconTooltipButton>
          {menuOpen ? (
            <div className="db-menu" role="menu">
              <button type="button" role="menuitem" onClick={takeScreenshot} disabled={isBlank || savingAction != null}>
                <Icon name="image" size={14} />
                Copy Screenshot
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
        <PreviewDrawOverlay
          active={drawOverlayOpen}
          captureViewport={!isBlank}
          captureSnapshot={desktopHostAvailable ? captureBrowserSnapshot : undefined}
          filePath={isBlank ? undefined : currentUrl}
          onActiveChange={setDrawOverlayOpen}
          sendDisabled={sendDisabled}
          sendDisabledReason="A task is currently running"
        >
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
            </div>
          )}
        </PreviewDrawOverlay>
      </div>
    </section>
  );
}

function IconTooltipButton({
  label,
  className,
  children,
  ...buttonProps
}: {
  label: string;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <span className="db-tooltip-anchor" data-tooltip={label}>
      <button
        {...buttonProps}
        type="button"
        className={['db-icon-btn', className].filter(Boolean).join(' ')}
        aria-label={label}
      >
        {children}
      </button>
    </span>
  );
}

const REFERENCE_ALL_CATEGORY = 'all';

function DesignBrowserStart({
  onNavigate,
  onSaveHarnessTask,
  savingTask,
}: {
  onNavigate: (url: string) => void;
  onSaveHarnessTask: (url: string) => Promise<void>;
  savingTask: boolean;
}) {
  const [activeCategory, setActiveCategory] = useState<string>(REFERENCE_ALL_CATEGORY);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);

  const visibleGroups = useMemo(
    () => filterReferenceGroups(REFERENCE_GROUPS, activeCategory, query),
    [activeCategory, query],
  );
  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;

  const resetFilters = () => {
    setQuery('');
    setActiveCategory(REFERENCE_ALL_CATEGORY);
    searchRef.current?.focus();
  };

  return (
    <div className="db-start">
      <div className="db-start-hero">
        <div className="db-start-hero-copy">
          <div className="db-kicker">Open Design browser</div>
          <h2>Reference Board</h2>
          <p className="db-start-sub">
            A curated set of references across inspiration, real product UI,
            motion, color, type, assets, and design systems. Open one to browse
            it live, or hand it to the Browser Harness agent to extract its
            design language.
          </p>
        </div>
        <div className="db-agent-card">
          <div className="db-agent-card-title">
            <Icon name="sparkles" size={15} />
            Browser Harness
          </div>
        </div>
      </div>

      <div className="db-reference-toolbar">
        <div
          className="db-reference-chips"
          role="tablist"
          aria-label="Reference category"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeCategory === REFERENCE_ALL_CATEGORY}
            className={`db-reference-chip${activeCategory === REFERENCE_ALL_CATEGORY ? ' is-active' : ''}`}
            onClick={() => setActiveCategory(REFERENCE_ALL_CATEGORY)}
          >
            All
            <span className="db-reference-chip-count">{REFERENCE_TOTAL}</span>
          </button>
          {REFERENCE_GROUPS.map((group) => (
            <button
              key={group.id}
              type="button"
              role="tab"
              aria-selected={activeCategory === group.id}
              className={`db-reference-chip${activeCategory === group.id ? ' is-active' : ''}`}
              onClick={() => setActiveCategory(group.id)}
            >
              {group.title}
              <span className="db-reference-chip-count">{group.sites.length}</span>
            </button>
          ))}
        </div>
        <div className="db-reference-search">
          <span className="db-reference-search-icon" aria-hidden>
            <Icon name="search" size={13} />
          </span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery('');
              }
            }}
            placeholder="Search references…"
            aria-label="Search references"
          />
          {hasQuery ? (
            <button
              type="button"
              className="db-reference-search-clear"
              aria-label="Clear search"
              onClick={() => {
                setQuery('');
                searchRef.current?.focus();
              }}
            >
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </div>
      </div>

      {visibleGroups.length === 0 ? (
        <div className="db-reference-empty" role="status">
          <p className="db-reference-empty-title">
            No references match “{trimmedQuery}”.
          </p>
          <button
            type="button"
            className="db-reference-empty-action"
            onClick={resetFilters}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="db-reference-board">
          {visibleGroups.map((group) => (
            <section key={group.id} className="db-reference-group">
              <h3>
                {group.title}
                <span className="db-reference-group-count">{group.sites.length}</span>
              </h3>
              <div className="db-reference-list">
                {group.sites.map((site) => (
                  <article
                    key={site.url}
                    className="db-reference-card"
                    onPointerEnter={() => warmBrowserOrigin(site.url)}
                  >
                    <button type="button" onClick={() => onNavigate(site.url)}>
                      <BrowserSiteIcon
                        className="db-reference-icon"
                        fallback="globe"
                        iconUrl={referenceIconUrl(site.url)}
                      />
                      <span className="db-reference-title">
                        <span>{site.label}</span>
                        <small>{hostnameFromUrl(site.url)}</small>
                      </span>
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
      )}
    </div>
  );
}

function BrowserSiteIcon({
  className,
  fallback,
  iconUrl,
}: {
  className?: string;
  fallback: 'globe' | 'history';
  iconUrl?: string;
}) {
  const [failed, setFailed] = useState(false);
  const cleanUrl = cleanIconUrl(iconUrl);
  return (
    <span className={['db-site-icon', className].filter(Boolean).join(' ')}>
      {cleanUrl && !failed ? (
        <img alt="" src={cleanUrl} onError={() => setFailed(true)} />
      ) : (
        <Icon name={fallback} size={13} />
      )}
    </span>
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
    typeof record.visitCount === 'number' &&
    (record.iconUrl === undefined || typeof record.iconUrl === 'string')
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

export interface AddressDisplayParts {
  url: string;
  title?: string;
}

export function formatAddressDisplayParts(url: string, title?: string): AddressDisplayParts {
  if (url === EMPTY_URL) return { url: '' };
  const cleanTitle = title?.trim();
  if (!cleanTitle) return { url };
  const fallback = labelFromUrl(url);
  if (cleanTitle === fallback || cleanTitle === url) return { url };
  return { url, title: cleanTitle };
}

export function formatAddressDisplay(url: string, title?: string): string {
  const parts = formatAddressDisplayParts(url, title);
  if (!parts.url) return '';
  if (!parts.title) return parts.url;
  return `${parts.url} / ${parts.title}`;
}

export function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function faviconUrl(url: string): string | undefined {
  if (!isHttpLikeUrl(url)) return undefined;
  try {
    return new URL('/favicon.ico', new URL(url).origin).toString();
  } catch {
    return undefined;
  }
}

/**
 * Resolve a reliable, colored favicon for a curated reference site.
 *
 * The Reference Board lists well-known public design sites, and many of them do
 * not serve a usable icon at `/favicon.ico` (wrong path, 404, or non-image), so
 * {@link faviconUrl} falls back to a flat grey globe for most of them. Routing
 * the request through a favicon service returns a real, correctly-sized brand
 * icon for essentially every domain, so the board shows actual logos instead.
 * Returns `undefined` for non-http(s) URLs so the globe fallback still applies.
 */
export function referenceIconUrl(url: string, size = 64): string | undefined {
  if (!isHttpLikeUrl(url)) return undefined;
  try {
    const host = new URL(url).hostname;
    if (!host) return undefined;
    return `https://www.google.com/s2/favicons?sz=${size}&domain=${encodeURIComponent(host)}`;
  } catch {
    return undefined;
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

function cleanIconUrl(url?: string): string | undefined {
  const value = url?.trim();
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return value;
  return undefined;
}

function warmBrowserOrigin(url: string): void {
  if (typeof document === 'undefined' || !isHttpLikeUrl(url)) return;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  if (warmedOrigins.has(origin)) return;
  warmedOrigins.add(origin);
  for (const rel of ['dns-prefetch', 'preconnect']) {
    const link = document.createElement('link');
    link.rel = rel;
    link.href = origin;
    if (rel === 'preconnect') link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  }
}

function canUseNativeHistoryNavigation(node: WebviewElement, delta: -1 | 1): boolean {
  try {
    if (delta < 0) return typeof node.canGoBack === 'function' && node.canGoBack();
    return typeof node.canGoForward === 'function' && node.canGoForward();
  } catch {
    return false;
  }
}

function imageSizeFromDataUrl(dataUrl: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({
      w: Math.max(1, img.naturalWidth || img.width),
      h: Math.max(1, img.naturalHeight || img.height),
    });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
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

// Writes a captured page image onto the system clipboard via the async
// Clipboard API. Decodes the data URL locally (no fetch) so it works under a
// strict connect-src CSP, and returns false instead of throwing when the
// browser lacks ClipboardItem or the write is blocked, so the caller can still
// fall back to the saved-to-project confirmation.
async function copyImageToClipboard(dataUrl: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
    const [header = '', base64 = ''] = dataUrl.split(',', 2);
    const mime = /^data:([^;,]+)/.exec(header)?.[1] || 'image/png';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const blob = new Blob([bytes], { type: mime });
    await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
    return true;
  } catch {
    return false;
  }
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
