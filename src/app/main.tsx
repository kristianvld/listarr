import * as ScrollArea from "@radix-ui/react-scroll-area";
import * as Tabs from "@radix-ui/react-tabs";
import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Clock3, ExternalLink, Film, Filter, Link2, RefreshCw, Search, Tv, X } from "lucide-react";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./tailwind.css";

import appLogo from "./assets/logo.png";
import letterboxdIcon from "./assets/icons/letterboxd.png";
import malIcon from "./assets/icons/myanimelist.png";
import sonarrIcon from "./assets/icons/sonarr.png";
import tmdbIcon from "./assets/icons/tmdb.png";
import tvdbIcon from "./assets/icons/tvdb.png";
import anoraPoster from "./assets/media/anora.jpg";
import asteroidPoster from "./assets/media/asteroid-city.jpg";
import erasedPoster from "./assets/media/erased.jpg";
import gurrenPoster from "./assets/media/gurren-lagann.jpg";
import monsterPoster from "./assets/media/monster.jpg";
import plutoPoster from "./assets/media/pluto.jpg";
import portraitPoster from "./assets/media/portrait.jpg";
import trianglePoster from "./assets/media/triangle.jpg";
import vinlandPoster from "./assets/media/vinland-saga.jpg";

type Service = "letterboxd" | "listarr" | "myanimelist" | "sonarr" | "tmdb" | "tvdb";
type FilterKey = "all" | "anime" | "movies" | "removed" | "multi";
type PanelKey = "timeline" | "linked";

type ExternalId = {
  href: string;
  service: "letterboxd" | "myanimelist" | "tmdb" | "tvdb";
};

type TimelineEvent = {
  at: string;
  code?: string;
  detail?: string;
  href: string;
  kind: "add" | "remove";
  label: string;
  service: "letterboxd" | "listarr" | "myanimelist";
  user: string;
};

type RelatedItem = {
  href?: string;
  id: string;
  imageUrl?: string;
  reason: string;
  state: "active" | "linked" | "removed";
  title: string;
  type: string;
  year: number;
};

type Lineage = {
  reason: string;
  sourceCode: string;
  sourceHref: string;
  sourceTitle: string;
  targetCode: string;
  targetHref: string;
  targetTitle: string;
};

type UiItem = {
  anime: boolean;
  endpoint: string;
  externalIds: ExternalId[];
  firstAddedAt: string;
  id: string;
  imageUrl?: string;
  kind: string;
  lastSeenAt: string;
  lineage?: Lineage;
  mediaType: "movie" | "tv";
  related: RelatedItem[];
  sourceSummary: string;
  sources: string[];
  status: "active" | "removed";
  statusDetail: string;
  timeline: TimelineEvent[];
  title: string;
  year: number;
};

type UiSnapshot = {
  generatedAt: string;
  items: UiItem[];
  sourceMode?: "event-log" | "live-refresh";
  stats: {
    active: number;
    all: number;
    anime: number;
    movies: number;
    multiSource: number;
    removed: number;
  };
};

type SearchParams = {
  filter: FilterKey;
  item?: string;
  panel: PanelKey;
  q: string;
};

const posterByTitle = new Map<string, string>([
  ["anora", anoraPoster],
  ["asteroid city", asteroidPoster],
  ["erased", erasedPoster],
  ["gurren lagann", gurrenPoster],
  ["monster", monsterPoster],
  ["pluto", plutoPoster],
  ["portrait of a lady on fire", portraitPoster],
  ["triangle", trianglePoster],
  ["vinland saga", vinlandPoster],
]);

const serviceIcons: Record<Exclude<Service, "listarr">, string> = {
  letterboxd: letterboxdIcon,
  myanimelist: malIcon,
  sonarr: sonarrIcon,
  tmdb: tmdbIcon,
  tvdb: tvdbIcon,
};

const serviceLabels: Record<Service, string> = {
  letterboxd: "Letterboxd",
  listarr: "Listarr",
  myanimelist: "MyAnimeList",
  sonarr: "Sonarr",
  tmdb: "TMDB",
  tvdb: "TVDB",
};

const serviceShortLabels: Record<Exclude<Service, "listarr">, string> = {
  letterboxd: "LB",
  myanimelist: "MAL",
  sonarr: "SR",
  tmdb: "TMDB",
  tvdb: "TVDB",
};

const detailsOpenDuration = 240;
const detailsCloseDuration = 180;

const detailsOpenAnimation: KeyframeAnimationOptions = {
  duration: detailsOpenDuration,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
  fill: "forwards",
};

const detailsCloseAnimation: KeyframeAnimationOptions = {
  duration: detailsCloseDuration,
  easing: "cubic-bezier(0.4, 0, 0.2, 1)",
  fill: "forwards",
};

const filterLabels: Array<[FilterKey, string]> = [
  ["all", "All"],
  ["anime", "Anime"],
  ["movies", "Movies"],
  ["removed", "Removed"],
  ["multi", "Multi-source"],
];

const queryClient = new QueryClient();

async function fetchSnapshot(): Promise<UiSnapshot> {
  const response = await fetch("/api/ui/snapshot");
  if (!response.ok) throw new Error(`Snapshot request failed: ${response.status}`);
  return (await response.json()) as UiSnapshot;
}

function normalizeSearch(search: Record<string, unknown>): SearchParams {
  const filter = filterLabels.some(([key]) => key === search.filter) ? (search.filter as FilterKey) : "all";
  const panel = search.panel === "linked" ? "linked" : "timeline";
  return {
    filter,
    item: typeof search.item === "string" ? search.item : undefined,
    panel,
    q: typeof search.q === "string" ? search.q : "",
  };
}

const rootRoute = createRootRoute({
  component: Root,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: normalizeSearch,
  component: AtlasApp,
});

const routeTree = rootRoute.addChildren([indexRoute]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function Root() {
  return (
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider delayDuration={250}>
        <div className="min-h-screen bg-[#080b0f] text-[#edf3fb]">
          <Outlet />
        </div>
      </Tooltip.Provider>
    </QueryClientProvider>
  );
}

function AtlasApp() {
  const search = indexRoute.useSearch();
  const navigate = useNavigate({ from: "/" });
  const [optimisticItem, setOptimisticItem] = useState(search.item);
  const snapshotQuery = useQuery({
    queryKey: ["ui-snapshot"],
    queryFn: fetchSnapshot,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });

  const snapshot = snapshotQuery.data;
  const items = snapshot?.items ?? [];
  const visibleItems = useMemo(() => filterItems(items, search), [items, search]);

  useEffect(() => {
    setOptimisticItem(search.item);
  }, [search.item]);

  const setSearch = (patch: Partial<SearchParams>) => {
    navigate({
      search: (prev) => ({ ...normalizeSearch(prev), ...patch }),
      replace: true,
    });
  };

  const refresh = () => snapshotQuery.refetch().then(() => undefined);

  return (
    <main className="mx-auto min-h-screen max-w-[1480px] text-[14px]">
      <Header
        query={search.q}
        setQuery={(q) => setSearch({ q })}
        onRefresh={refresh}
      />
      <section className="p-3 lg:p-4">
        <FilterBar
          active={search.filter}
          stats={snapshot?.stats}
          onChange={(filter) => {
            setOptimisticItem(undefined);
            setSearch({ filter, item: undefined, panel: "timeline" });
          }}
        />
        <StatusStrip snapshot={snapshot} loading={snapshotQuery.isLoading} error={snapshotQuery.error} />
        <ScrollArea.Root className="overflow-hidden rounded-lg border border-[#293644]">
          <ScrollArea.Viewport className="max-h-[calc(100vh-190px)] smooth-scrollbar">
            <div className="overflow-hidden">
              {visibleItems.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  open={item.id === optimisticItem}
                  panel={search.panel}
                  onToggle={() => {
                    const nextItem = item.id === optimisticItem ? undefined : item.id;
                    setOptimisticItem(nextItem);
                    setSearch({ item: nextItem, panel: "timeline" });
                  }}
                  onPanelChange={(panel) => setSearch({ panel })}
                />
              ))}
              {snapshotQuery.isSuccess && visibleItems.length === 0 ? <EmptyState query={search.q} /> : null}
            </div>
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar className="flex w-2 bg-transparent p-px" orientation="vertical">
            <ScrollArea.Thumb className="flex-1 rounded-full bg-[#293644]" />
          </ScrollArea.Scrollbar>
        </ScrollArea.Root>
      </section>
    </main>
  );
}

function Header({
  onRefresh,
  query,
  setQuery,
}: {
  onRefresh: () => Promise<void> | void;
  query: string;
  setQuery: (value: string) => void;
}) {
  const doneRef = useRef(false);
  const mountedRef = useRef(true);
  const refreshBusyRef = useRef(false);
  const transitionFallbackRef = useRef<number | undefined>(undefined);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshTurns, setRefreshTurns] = useState(0);

  useEffect(
    () => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        if (transitionFallbackRef.current !== undefined) window.clearTimeout(transitionFallbackRef.current);
      };
    },
    [],
  );

  const clearRefreshFallback = () => {
    if (transitionFallbackRef.current !== undefined) {
      window.clearTimeout(transitionFallbackRef.current);
      transitionFallbackRef.current = undefined;
    }
  };

  const armRefreshFallback = () => {
    clearRefreshFallback();
    transitionFallbackRef.current = window.setTimeout(() => {
      settleRefreshHalfTurn();
    }, 900);
  };

  const finishRefreshAnimation = () => {
    if (!mountedRef.current) return;
    clearRefreshFallback();
    refreshBusyRef.current = false;
    setRefreshBusy(false);
  };

  function settleRefreshHalfTurn() {
    if (!mountedRef.current || !refreshBusyRef.current) return;
    clearRefreshFallback();
    if (doneRef.current) {
      finishRefreshAnimation();
      return;
    }

    setRefreshTurns((turns) => turns + 0.5);
    armRefreshFallback();
  }

  const handleRefreshTransitionEnd = (event: React.TransitionEvent<HTMLSpanElement>) => {
    if (event.propertyName !== "transform") return;
    settleRefreshHalfTurn();
  };

  const runRefresh = () => {
    if (refreshBusyRef.current) return;
    refreshBusyRef.current = true;
    doneRef.current = false;
    setRefreshBusy(true);
    setRefreshTurns((turns) => turns + 0.5);
    armRefreshFallback();

    Promise.resolve()
      .then(onRefresh)
      .finally(() => {
        if (!mountedRef.current) return;
        doneRef.current = true;
      })
      .catch(() => undefined);
  };

  return (
    <header className="grid grid-cols-[auto_minmax(0,1fr)_40px] items-center gap-2 border-b border-[#293644] bg-[#090d12] p-3 min-[560px]:grid-cols-[auto_minmax(180px,1fr)_40px] min-[560px]:gap-3">
      <a className="col-start-1 row-start-1 flex items-center gap-2 font-semibold" href="/">
        <img className="h-9 w-9 min-[560px]:h-8 min-[560px]:w-8" src={appLogo} alt="" />
        <span className="hidden text-lg min-[560px]:block">Listarr</span>
      </a>
      <label className="col-span-3 row-start-2 flex h-11 min-w-0 items-center gap-3 rounded-lg border border-[#293644] bg-[#080c11] px-3 text-[#94a2b4] focus-within:border-[#68aefd] min-[560px]:col-span-1 min-[560px]:col-start-2 min-[560px]:row-start-1">
        <Search className="h-5 w-5 shrink-0" />
        <input
          className="min-w-0 flex-1 bg-transparent text-[14px] text-[#edf3fb] outline-none placeholder:text-[#6d7a8b]"
          placeholder="Search title, external ID, list, source"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button className="rounded p-1 text-[#94a2b4] hover:text-white" onClick={() => setQuery("")} type="button">
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </label>
      <TooltipButton label="Refresh snapshot">
        <button
          aria-busy={refreshBusy}
          aria-label="Refresh snapshot"
          className="col-start-3 row-start-1 flex h-10 w-10 items-center justify-center rounded-lg border border-[#293644] bg-[#121923] text-[#c4d0df] transition hover:border-[#3a4a5c] hover:bg-[#17202b] disabled:cursor-wait disabled:opacity-80"
          disabled={refreshBusy}
          onClick={runRefresh}
          type="button"
        >
          <span
            aria-hidden="true"
            className="refresh-icon h-5 w-5"
            onTransitionEnd={handleRefreshTransitionEnd}
            style={{ transform: `rotate(${refreshTurns * 360}deg)` }}
          >
            <RefreshCw className="h-5 w-5" />
          </span>
        </button>
      </TooltipButton>
    </header>
  );
}

function TooltipButton({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="z-30 rounded bg-[#edf3fb] px-2 py-1 text-xs font-bold text-[#080b0f]" sideOffset={6}>
          {label}
          <Tooltip.Arrow className="fill-[#edf3fb]" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function FilterBar({
  active,
  onChange,
  stats,
}: {
  active: FilterKey;
  onChange: (filter: FilterKey) => void;
  stats?: UiSnapshot["stats"];
}) {
  const counts: Record<FilterKey, number> = {
    all: stats?.all ?? 0,
    anime: stats?.anime ?? 0,
    movies: stats?.movies ?? 0,
    multi: stats?.multiSource ?? 0,
    removed: stats?.removed ?? 0,
  };

  return (
    <nav className="mb-3 flex gap-2 overflow-x-auto border-b border-[#293644] pb-3 smooth-scrollbar" aria-label="Media filters">
      {filterLabels.map(([key, label]) => (
        <button
          key={key}
          className={`flex h-8 shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] font-medium transition ${
            active === key ? "bg-[#121923] text-white" : "text-[#94a2b4] hover:bg-white/5 hover:text-white"
          }`}
          onClick={() => onChange(key)}
          type="button"
        >
          {label}
          <span className="min-w-6 rounded-full bg-white/[.08] px-2 py-0.5 text-xs text-[#42d7c8]">{counts[key].toLocaleString()}</span>
        </button>
      ))}
    </nav>
  );
}

function StatusStrip({ error, loading, snapshot }: { error: Error | null; loading: boolean; snapshot?: UiSnapshot }) {
  if (loading) return <div className="mb-3 rounded-lg border border-[#293644] bg-[#090d12] px-3 py-2 text-[#94a2b4]">Loading snapshot…</div>;
  if (error) return <div className="mb-3 rounded-lg border border-[#62323b] bg-[#1e0f14] px-3 py-2 text-[#ff7171]">{error.message}</div>;
  if (!snapshot) return null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-[#94a2b4]">
      <span>{snapshot.stats.active.toLocaleString()} active</span>
      <span aria-hidden="true" className="text-[#526071]">
        ·
      </span>
      <span>{snapshot.stats.removed.toLocaleString()} removed</span>
      <span aria-hidden="true" className="text-[#526071]">
        ·
      </span>
      <span>
        Updated{" "}
        <time dateTime={snapshot.generatedAt} title={formatDate(snapshot.generatedAt)}>
          {formatListDate(snapshot.generatedAt)}
        </time>
      </span>
    </div>
  );
}

function ItemRow({
  item,
  onPanelChange,
  onToggle,
  open,
  panel,
}: {
  item: UiItem;
  onPanelChange: (panel: PanelKey) => void;
  onToggle: () => void;
  open: boolean;
  panel: PanelKey;
}) {
  return (
    <article className="border-t border-[#293644] first:border-t-0">
      <button
        aria-expanded={open}
        className={`grid min-h-14 w-full grid-cols-[42px_minmax(0,1fr)] items-center gap-3 px-3 py-1.5 text-left transition hover:bg-white/[.035] min-[620px]:grid-cols-[46px_minmax(150px,.9fr)_145px_138px_64px] lg:grid-cols-[46px_minmax(190px,1.15fr)_minmax(220px,1fr)_minmax(150px,.65fr)_82px] ${
          open ? "bg-white/[.025]" : "bg-transparent"
        }`}
        onClick={onToggle}
        type="button"
      >
        <Poster item={item} compact />
        <span className="min-w-0">
          <b className="block truncate text-[14px] font-semibold text-white">{item.title}</b>
          <small className="block truncate text-[12px] text-[#94a2b4]">
            {item.year} · {item.kind}
          </small>
        </span>
        <span className="hidden min-w-0 items-center gap-2 min-[620px]:grid min-[620px]:grid-cols-[auto_minmax(0,1fr)]">
          <SourceIconCluster sources={item.sources} />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium text-[#dbe4ef]">{item.sourceSummary}</span>
            <small className="block truncate text-[12px] text-[#94a2b4]">
              {item.timeline.length} timeline {item.timeline.length === 1 ? "event" : "events"}
            </small>
          </span>
        </span>
        <span className="hidden min-w-0 min-[620px]:block">
          <span className="block truncate text-[13px] font-medium tabular-nums text-[#dbe4ef]" title={formatDate(item.lastSeenAt)}>
            {formatListDate(item.lastSeenAt)}
          </span>
          <small className="block truncate text-[12px] text-[#94a2b4]">{item.endpoint}</small>
        </span>
        <span className="hidden justify-self-end min-[620px]:block">
          <StatusBadge status={item.status} />
        </span>
      </button>
      <ExpandableDetails item={item} onPanelChange={onPanelChange} open={open} panel={panel} />
    </article>
  );
}

function ExpandableDetails({
  item,
  onPanelChange,
  open,
  panel,
}: {
  item: UiItem;
  onPanelChange: (panel: PanelKey) => void;
  open: boolean;
  panel: PanelKey;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const animationRef = useRef<Animation | null>(null);
  const firstRender = useRef(true);
  const [present, setPresent] = useState(open);

  useLayoutEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      if (open) {
        setPresent(true);
      }
      return undefined;
    }

    if (open) {
      const section = sectionRef.current;
      const content = contentRef.current;
      if (!section || !content) return undefined;

      animationRef.current?.cancel();
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const start = present ? section.getBoundingClientRect().height : 0;
      const end = content.scrollHeight;
      if (!present) setPresent(true);

      if (reduceMotion) {
        section.style.height = "auto";
        return undefined;
      }

      section.style.height = `${start}px`;
      const animation = section.animate([{ height: `${start}px` }, { height: `${end}px` }], detailsOpenAnimation);
      animationRef.current = animation;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (animationRef.current !== animation) return;
        animationRef.current = null;
        animation.cancel();
        section.style.height = "auto";
      };
      const finishTimer = window.setTimeout(finish, detailsOpenDuration + 80);
      animation.onfinish = finish;
      void animation.finished.then(finish).catch(() => undefined);

      return () => {
        window.clearTimeout(finishTimer);
        animation.onfinish = null;
        animation.cancel();
      };
    }

    if (!present) return undefined;

    const section = sectionRef.current;
    const content = contentRef.current;
    if (!section || !content) return undefined;

    animationRef.current?.cancel();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = section.getBoundingClientRect().height || content.scrollHeight;

    if (reduceMotion) {
      section.style.height = "0px";
      setPresent(false);
      return undefined;
    }

    section.style.height = `${start}px`;
    const animation = section.animate([{ height: `${start}px` }, { height: "0px" }], detailsCloseAnimation);
    animationRef.current = animation;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (animationRef.current !== animation) return;
      animationRef.current = null;
      animation.cancel();
      section.style.height = "0px";
      setPresent(false);
    };
    const finishTimer = window.setTimeout(finish, detailsCloseDuration + 80);
    animation.onfinish = finish;
    void animation.finished.then(finish).catch(() => undefined);

    return () => {
      window.clearTimeout(finishTimer);
      animation.onfinish = null;
      animation.cancel();
    };
  }, [item.id, open]);

  if (!open && !present) return null;

  return (
    <section
      ref={sectionRef}
      aria-hidden={!open}
      className="curtain-details border-t border-[#293644] bg-white/[.018]"
    >
      <div ref={contentRef}>
        <ExpandedItem item={item} panel={panel} onPanelChange={onPanelChange} />
      </div>
    </section>
  );
}

function ExpandedItem({ item, onPanelChange, panel }: { item: UiItem; onPanelChange: (panel: PanelKey) => void; panel: PanelKey }) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 p-3 md:grid-cols-[116px_minmax(0,1fr)]">
      <div className="min-w-0">
        <Poster item={item} />
        <ExternalLogoLinks ids={item.externalIds} />
      </div>
      <div className="min-w-0">
        <div className="grid gap-1.5 text-[13px]">
          <FactRow icon="clock" label="Added" title={formatDate(item.firstAddedAt)} value={formatShortDate(item.firstAddedAt)} />
          <FactRow icon="clock" label="State" value={item.statusDetail} />
        </div>
        {item.lineage ? <LineageNote lineage={item.lineage} /> : null}
        <Tabs.Root className="mt-3" value={panel} onValueChange={(value) => onPanelChange(value as PanelKey)}>
          <Tabs.List className="flex gap-2">
            <Tabs.Trigger className={tabClass(panel === "timeline")} value="timeline">
              Timeline <span>{item.timeline.length}</span>
            </Tabs.Trigger>
            <Tabs.Trigger className={tabClass(panel === "linked")} value="linked">
              Linked <span>{item.related.length}</span>
            </Tabs.Trigger>
          </Tabs.List>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={panel}
              animate={{ opacity: 1, y: 0 }}
              className="mt-2"
              exit={{ opacity: 0, y: -4 }}
              initial={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16 }}
            >
              {panel === "timeline" ? <Timeline events={item.timeline} /> : <LinkedItems items={item.related} />}
            </motion.div>
          </AnimatePresence>
        </Tabs.Root>
      </div>
    </div>
  );
}

function ExternalLogoLinks({ ids }: { ids: ExternalId[] }) {
  if (ids.length === 0) return null;

  return (
    <div className="external-logo-strip">
      {ids.map((externalId) => (
        <TooltipButton key={`${externalId.service}:${externalId.href}`} label={serviceLabels[externalId.service]}>
          <a
            aria-label={`Open ${serviceLabels[externalId.service]}`}
            className="external-logo-link"
            href={externalId.href}
            rel="noreferrer"
            target="_blank"
          >
            <BrandIcon service={externalId.service} />
          </a>
        </TooltipButton>
      ))}
    </div>
  );
}

function LineageNote({ lineage }: { lineage: Lineage }) {
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg border border-[#293644] bg-[#090d12] px-2 py-1.5 text-[12px] text-[#94a2b4]">
      <Link2 className="h-4 w-4 shrink-0 text-[#42d7c8]" />
      <span className="min-w-0">
        <span className="font-semibold text-white">Old mapping:</span>{" "}
        <a className="font-medium text-white hover:text-[#68aefd]" href={lineage.sourceHref} rel="noreferrer" target="_blank">
          {lineage.sourceTitle}
        </a>
        <ArrowRight aria-hidden="true" className="mx-1 inline h-3.5 w-3.5 align-[-2px] text-[#42d7c8]" />
        <a className="font-medium text-white hover:text-[#68aefd]" href={lineage.targetHref} rel="noreferrer" target="_blank">
          {lineage.targetTitle}
        </a>
      </span>
    </div>
  );
}

function FactRow({ code, icon, label, title, value }: { code?: boolean; icon: "clock" | "link"; label: string; title?: string; value: string }) {
  const Icon = icon === "clock" ? Clock3 : Link2;
  return (
    <div className="grid min-h-7 grid-cols-[18px_52px_minmax(0,1fr)] items-center gap-2 border-b border-white/[.08] pb-1.5 last:border-b-0 last:pb-0">
      <Icon className="h-4 w-4 text-[#94a2b4]" />
      <b className="text-[10px] font-semibold uppercase text-white">{label}</b>
      {code ? (
        <code className="justify-self-start rounded border border-white/10 bg-[#070a0f] px-2 py-1 text-[13px] text-[#42d7c8]">{value}</code>
      ) : (
        <span className="truncate tabular-nums text-[#c4d0df]" title={title}>
          {value}
        </span>
      )}
    </div>
  );
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  const displayEvents = [...events].reverse();

  return (
    <div className="grid gap-1.5">
      {displayEvents.map((event, index) => (
        <a
          key={`${event.at}:${event.service}:${index}`}
          className="grid min-h-10 grid-cols-[32px_minmax(0,1fr)_86px_14px] items-center gap-2 rounded-lg border border-[#293644] bg-[#090d12] px-2 py-1.5 transition hover:border-[#3a4a5c] hover:bg-[#101822] max-[720px]:grid-cols-[24px_minmax(0,1fr)_74px_14px] max-[720px]:gap-1.5"
          href={event.href}
          rel="noreferrer"
          target={event.href === "#" ? undefined : "_blank"}
          title={timelineEventTitle(event)}
        >
          <span>{event.service === "listarr" ? <Clock3 className="h-5 w-5 text-[#94a2b4]" /> : <BrandIcon service={event.service} />}</span>
          <span className="min-w-0">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-[13px] font-semibold text-white">{serviceLabels[event.service]}</span>
              <TimelineAction kind={event.kind} />
              <small className="min-w-0 truncate text-[12px] text-[#94a2b4]">
                {timelineEventSummary(event)}
              </small>
            </span>
          </span>
          <time
            className="justify-self-end whitespace-nowrap text-[11px] tabular-nums text-[#94a2b4]"
            dateTime={event.at}
            title={formatDate(event.at)}
          >
            {formatTimelineDate(event.at)}
          </time>
          {event.href === "#" ? <span /> : <ExternalLink className="h-3.5 w-3.5 text-[#94a2b4]" />}
        </a>
      ))}
    </div>
  );
}

function TimelineAction({ kind }: { kind: TimelineEvent["kind"] }) {
  const removed = kind === "remove";
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold ${removed ? "bg-[#2a1518] text-[#ff7171]" : "bg-[#10251d] text-[#6dde9b]"}`}>
      {removed ? "Removed" : "Added"}
    </span>
  );
}

function timelineEventSummary(event: TimelineEvent): string {
  const label = event.label.startsWith("Watchlist item:") ? "Watchlist" : event.label;
  const action = event.kind === "remove" ? "Removed" : "Added";
  if (label === action) return event.user;

  return `${label} · ${event.user}`;
}

function timelineEventTitle(event: TimelineEvent): string {
  return [serviceLabels[event.service], event.label, event.detail, event.code, event.user, formatDate(event.at)].filter(Boolean).join("\n");
}

function LinkedItems({ items }: { items: RelatedItem[] }) {
  if (items.length === 0) return <div className="rounded-lg border border-[#293644] bg-[#090d12] px-3 py-3 text-[#94a2b4]">No linked entries in the current snapshot.</div>;

  return (
    <div className="grid gap-1.5">
      {items.map((item) => (
        <a
          key={item.id}
          className="grid min-h-12 grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-[#293644] bg-[#090d12] px-2 py-1.5 transition hover:border-[#3a4a5c] hover:bg-[#101822]"
          href={item.href ?? `/?item=${encodeURIComponent(item.id)}&panel=linked`}
          rel={item.href ? "noreferrer" : undefined}
          target={item.href ? "_blank" : undefined}
        >
          <RelatedPoster item={item} />
          <span className="min-w-0">
            <b className="block truncate font-semibold text-white">{item.title}</b>
            <small className="block truncate text-[#94a2b4]">
              {item.reason} · {item.year} · {item.type}
            </small>
          </span>
          <StatusBadge status={item.state} />
        </a>
      ))}
    </div>
  );
}

function RelatedPoster({ item }: { item: RelatedItem }) {
  const mediaType = item.type.toLowerCase().includes("movie") ? "movie" : "tv";
  if (!item.imageUrl) return <PosterFallback mediaType={mediaType} title={item.title} small />;

  return (
    <img
      alt=""
      className="h-9 w-7 shrink-0 rounded border border-[#293644] bg-[#121923] object-cover"
      decoding="async"
      loading="lazy"
      src={posterSrc(item.imageUrl)}
    />
  );
}

function Poster({ compact, item }: { compact?: boolean; item: UiItem }) {
  const poster = item.imageUrl || posterByTitle.get(item.title.toLowerCase());
  const size = compact ? "h-10 w-8" : "h-[136px] w-[92px] md:h-44 md:w-[116px]";

  if (poster) {
    return (
      <img
        className={`${size} rounded border border-[#293644] bg-[#121923] object-cover`}
        src={posterSrc(poster)}
        alt=""
        decoding="async"
        loading={compact ? "lazy" : "eager"}
      />
    );
  }
  return <PosterFallback className={size} mediaType={item.mediaType} title={item.title} />;
}

function posterSrc(src: string): string {
  return src.startsWith("http://") || src.startsWith("https://") ? `/api/ui/poster?url=${encodeURIComponent(src)}` : src;
}

function PosterFallback({ className = "h-12 w-9", mediaType, small, title }: { className?: string; mediaType?: "movie" | "tv"; small?: boolean; title: string }) {
  const Icon = mediaType === "tv" ? Tv : Film;
  return (
    <span
      aria-hidden="true"
      className={`${small ? "h-9 w-7" : className} poster-fallback flex shrink-0 items-center justify-center rounded`}
      title={title}
    >
      <Icon className={small ? "h-4 w-4" : "h-5 w-5"} />
    </span>
  );
}

function BrandIcon({ service }: { service: Exclude<Service, "listarr"> }) {
  const [failed, setFailed] = useState(false);

  return (
    <span className={`brand-icon ${service} ${failed ? "failed" : ""}`}>
      {failed ? (
        <span aria-hidden="true" className="brand-icon-fallback">
          {serviceShortLabels[service]}
        </span>
      ) : (
        <img onError={() => setFailed(true)} src={serviceIcons[service]} alt={serviceLabels[service]} />
      )}
    </span>
  );
}

function SourceIconCluster({ sources }: { sources: string[] }) {
  const normalized = sources.map((source) => (source === "MyAnimeList" ? "myanimelist" : source.toLowerCase())) as Array<Exclude<Service, "listarr">>;
  return (
    <span className="flex items-center gap-1">
      {normalized.slice(0, 3).map((source) => (
        <BrandIcon key={source} service={source} />
      ))}
    </span>
  );
}

function StatusBadge({ label, status }: { label?: string; status: "active" | "linked" | "removed" }) {
  const display = label ?? status.charAt(0).toUpperCase() + status.slice(1);
  const className =
    status === "active"
      ? "bg-[#10251d] text-[#6dde9b]"
      : status === "linked"
        ? "bg-[#0e2730] text-[#67d9ff]"
        : "bg-[#2a1518] text-[#ff7171]";

  return (
    <span className={`justify-self-end rounded-full px-2 py-0.5 text-[11px] font-semibold ${className}`}>
      {display}
    </span>
  );
}

function EmptyState({ query }: { query: string }) {
  return (
    <div className="grid min-h-64 place-items-center px-4 text-center">
      <div>
        <Filter className="mx-auto mb-3 h-8 w-8 text-[#6d7a8b]" />
        <div className="font-semibold text-white">No matching entries</div>
        <div className="mt-1 text-[#94a2b4]">{query ? `Nothing matched "${query}".` : "Try a different filter."}</div>
      </div>
    </div>
  );
}

function tabClass(active: boolean) {
  return `flex h-8 items-center gap-2 rounded-lg border px-3 text-[13px] font-medium transition ${
    active ? "border-[#3a4a5c] bg-[#121923] text-white" : "border-[#293644] bg-[#090d12] text-[#94a2b4] hover:bg-[#101822]"
  } [&>span]:rounded-full [&>span]:bg-[#0d3a3a] [&>span]:px-2 [&>span]:py-0.5 [&>span]:text-[#42d7c8]`;
}

function filterItems(items: UiItem[], search: SearchParams): UiItem[] {
  const query = search.q.trim().toLowerCase();

  return items.filter((item) => {
    if (search.filter === "anime" && !item.anime) return false;
    if (search.filter === "movies" && item.mediaType !== "movie") return false;
    if (search.filter === "removed" && item.status !== "removed") return false;
    if (search.filter === "multi" && item.sources.length <= 1) return false;

    if (!query) return true;

    const haystack = [
      item.title,
      item.year,
      item.kind,
      item.endpoint,
      item.sourceSummary,
      ...item.sources,
      ...item.related.map((related) => `${related.title} ${related.reason} ${related.type}`),
      ...item.timeline.map((event) => `${event.label} ${event.user} ${event.code ?? ""}`),
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  });
}

function formatDate(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const parts = new Intl.DateTimeFormat("sv-SE", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    timeZoneName: "short",
    year: "numeric",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

function formatShortDate(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const parts = new Intl.DateTimeFormat("sv-SE", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function formatTimelineDate(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
  })
    .format(date)
    .replace(",", "");
}

function formatListDate(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const parts = new Intl.DateTimeFormat("en", {
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    year: "numeric",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const year = get("year");
  const yearSuffix = year && Number(year) !== new Date().getFullYear() ? ` ${year}` : "";
  return `${get("month")} ${get("day")}${yearSuffix} ${get("hour")}:${get("minute")}`;
}

type AppRoot = ReturnType<typeof createRoot>;

declare global {
  interface Window {
    __listarrRoot?: AppRoot;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Listarr root element is missing");

window.__listarrRoot ??= createRoot(rootElement);
window.__listarrRoot.render(<RouterProvider router={router} />);
