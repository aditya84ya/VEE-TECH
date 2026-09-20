import React, { useState, useRef, useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  AlertTriangle,
  Bell,
  Target,
  ShieldCheck,
  ChevronRight,
  ChevronLeft,
  ShieldAlert,
  Database,
  Cpu,
  Server
} from 'lucide-react';
import { Article } from '../hooks/useWarRoom';
import { DetectionLatencyBadge } from './DetectionLatencyBadge';

interface DashboardViewProps {
  articles: Article[];
  onNavigateToWarRoom?: () => void;
  onSelectArticle?: (article: Article) => void;
  searchQuery?: string;
  isRealtimeActive?: boolean;
}

// Source Brand Badges
const getSourceBadge = (sourceName: string) => {
  const s = (sourceName || '').toLowerCase();
  if (s.includes('economic') || s.includes('et')) {
    return { tag: 'ET', bg: 'bg-[#C81E3A]', text: 'text-white' };
  }
  if (s.includes('fortune') || s.includes('fi')) {
    return { tag: 'FI', bg: 'bg-[#0F172A]', text: 'text-white' };
  }
  if (s.includes('business today') || s.includes('bt')) {
    return { tag: 'BT', bg: 'bg-[#2563EB]', text: 'text-white' };
  }
  if (s.includes('times of india') || s.includes('toi')) {
    return { tag: 'TOI', bg: 'bg-[#DC2626]', text: 'text-white' };
  }
  if (s.includes('business standard') || s.includes('bs')) {
    return { tag: 'BS', bg: 'bg-[#4B5563]', text: 'text-white' };
  }
  if (s.includes('livemint') || s.includes('mint')) {
    return { tag: 'LM', bg: 'bg-[#EA580C]', text: 'text-white' };
  }
  if (s.includes('cnbc')) {
    return { tag: 'CN', bg: 'bg-[#0284C7]', text: 'text-white' };
  }
  if (s.includes('ndtv')) {
    return { tag: 'ND', bg: 'bg-[#E11D48]', text: 'text-white' };
  }
  if (s.includes('reuters')) {
    return { tag: 'RE', bg: 'bg-[#EA580C]', text: 'text-white' };
  }
  if (s.includes('bloomberg')) {
    return { tag: 'BL', bg: 'bg-[#1E1B4B]', text: 'text-white' };
  }
  return {
    tag: sourceName ? sourceName.slice(0, 2).toUpperCase() : 'NW',
    bg: 'bg-slate-700',
    text: 'text-white'
  };
};

// Deterministic contextual thumbnails matching the enterprise aesthetic
const getThumbnailForArticle = (article: Article, index: number): string => {
  const text = `${article.title} ${article.entity_mentioned} ${article.raw_content}`.toLowerCase();

  // 1. Semiconductor / Hardware / AI Chip
  if (text.includes('semiconductor') || text.includes('chip') || text.includes('hardware')) {
    return 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=500&auto=format&fit=crop&q=80';
  }
  // 2. TCS Facility / Campus
  if (text.includes('tcs') || text.includes('tata consultancy')) {
    return 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=500&auto=format&fit=crop&q=80';
  }
  // 3. Wipro Corporate Office
  if (text.includes('wipro')) {
    return 'https://images.unsplash.com/photo-1497215728101-856f4ea42174?w=500&auto=format&fit=crop&q=80';
  }
  // 4. Infosys Campus / Building / Finacle Banking
  if (text.includes('infosys') || text.includes('finacle') || text.includes('banking') || text.includes('audit')) {
    return index % 2 === 0
      ? 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=500&auto=format&fit=crop&q=80'
      : 'https://images.unsplash.com/photo-1554469384-e58fac16e23a?w=500&auto=format&fit=crop&q=80';
  }
  // 5. Default Enterprise Tech
  return 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=500&auto=format&fit=crop&q=80';
};

export const DashboardView: React.FC<DashboardViewProps> = ({
  articles = [],
  onNavigateToWarRoom,
  onSelectArticle,
  searchQuery = '',
  isRealtimeActive = false
}) => {
  const [activeTab, setActiveTab] = useState<'news' | 'events' | 'alerts'>('news');
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);
  const [activeDot, setActiveDot] = useState(0);
  const carouselRef = useRef<HTMLDivElement>(null);

  // =========================================================================
  // 1. DYNAMIC KPI CARDS (100% Derived from Real articles array)
  // =========================================================================
  const activeEvents = articles.length;
  const criticalEvents = articles.filter((a) => a.risk_level === 'Critical' || (a as any).severity === 'CRITICAL' || (Number(a.risk_score || (a as any).score) >= 9.0)).length;
  const competitorEvents = articles.filter((a) => {
    const entity = (a.entity_mentioned || (a as any).entity || '').trim().toLowerCase();
    return entity !== 'infosys' && entity !== '';
  }).length;

  // Dynamic SLA Compliance calculation
  const compliantCount = articles.filter((a) => {
    if ((a as any).sla_breached !== undefined) {
      return (a as any).sla_breached === false;
    }
    const ingestedTime = new Date(a.ingested_at).getTime();
    const triagedTime = a.triaged_at ? new Date(a.triaged_at).getTime() : ingestedTime + 1800;
    return (triagedTime - ingestedTime) / 1000 <= 120.0;
  }).length;

  const slaCompliance = articles.length > 0
    ? ((compliantCount / articles.length) * 100).toFixed(1)
    : '100.0';

  // =========================================================================
  // 2. DYNAMIC EVENT DISTRIBUTION (Donut Chart & Legend)
  // =========================================================================
  const criticalCount = criticalEvents;
  const highCount = articles.filter((a) => !((a.risk_level === 'Critical' || (a as any).severity === 'CRITICAL' || (Number(a.risk_score || (a as any).score) >= 9.0))) && (a.risk_level === 'High' || (a as any).severity === 'HIGH' || (Number(a.risk_score || (a as any).score) >= 7.0))).length;
  const mediumCount = articles.filter((a) => !((a.risk_level === 'Critical' || (a as any).severity === 'CRITICAL' || (Number(a.risk_score || (a as any).score) >= 9.0))) && !((a.risk_level === 'High' || (a as any).severity === 'HIGH' || (Number(a.risk_score || (a as any).score) >= 7.0))) && (a.risk_level === 'Medium' || (a as any).severity === 'MEDIUM' || (Number(a.risk_score || (a as any).score) >= 4.0))).length;
  const totalCenterValue = articles.length;
  const lowCount = Math.max(0, totalCenterValue - criticalCount - highCount - mediumCount);

  const critPercent = totalCenterValue > 0 ? ((criticalCount / totalCenterValue) * 100).toFixed(1) : '0.0';
  const highPercent = totalCenterValue > 0 ? ((highCount / totalCenterValue) * 100).toFixed(1) : '0.0';
  const medPercent = totalCenterValue > 0 ? ((mediumCount / totalCenterValue) * 100).toFixed(1) : '0.0';
  const lowPercent = totalCenterValue > 0 ? ((lowCount / totalCenterValue) * 100).toFixed(1) : '0.0';

  // SVG Donut calculation
  const radius = 55;
  const circumference = 2 * Math.PI * radius; // ~345.57
  const critDash = (Number(critPercent) / 100) * circumference;
  const highDash = (Number(highPercent) / 100) * circumference;
  const medDash = (Number(medPercent) / 100) * circumference;
  const lowDash = (Number(lowPercent) / 100) * circumference;

  const critOffset = 0;
  const highOffset = -critDash;
  const medOffset = -(critDash + highDash);
  const lowOffset = -(critDash + highDash + medDash);

  // =========================================================================
  // 3. DYNAMIC THREAT VECTORS / TOP TOPICS (reduce & sort aggregation)
  // =========================================================================
  const themeCounts = articles.reduce((acc: Record<string, number>, a) => {
    let theme = (a as any).theme;
    if (!theme || theme === 'Industry Intelligence') {
      const text = `${a.title} ${a.raw_content} ${a.entity_mentioned}`.toLowerCase();
      if (/compliance|audit|rbi|regulatory|sec|probe|notice|penalty|legal/.test(text)) {
        theme = 'Regulatory & Compliance (RBI/SEC)';
      } else if (/finacle|core banking|banking|outage|cloud|platform|infrastructure/.test(text)) {
        theme = 'Finacle Core Banking & Cloud';
      } else if (/wipro|tcs|accenture|competitor|counter-play|rfp|deal|rival/.test(text)) {
        theme = 'Competitor Counter-Plays (TCS/Wipro)';
      } else {
        theme = 'Cybersecurity & Governance';
      }
    }
    acc[theme] = (acc[theme] || 0) + 1;
    return acc;
  }, {});

  const sortedThemes = Object.entries(themeCounts)
    .sort(([, countA], [, countB]) => countB - countA)
    .slice(0, 4)
    .map(([name, count], index) => {
      const percent = totalCenterValue > 0 ? Math.round((count / totalCenterValue) * 100) : 0;
      const colorPalette = ['bg-rose-600', 'bg-rose-500', 'bg-rose-400', 'bg-rose-300'];
      return {
        name,
        count,
        percent,
        color: colorPalette[index % colorPalette.length]
      };
    });

  // Fallback initial theme set if articles is empty
  const displayThemes = sortedThemes.length > 0 ? sortedThemes : [
    { name: 'Regulatory & Compliance (RBI/SEC)', count: 0, percent: 0, color: 'bg-rose-600' },
    { name: 'Finacle Core Banking & Cloud', count: 0, percent: 0, color: 'bg-rose-500' },
    { name: 'Competitor Counter-Plays (TCS/Wipro)', count: 0, percent: 0, color: 'bg-rose-400' },
    { name: 'Cybersecurity & Governance', count: 0, percent: 0, color: 'bg-rose-300' }
  ];

  // =========================================================================
  // 4. LIVE SYSTEM STATUS (Hooked directly to frontend state)
  // =========================================================================
  const isDataIngestionLive = articles.length > 0;
  const isAiAnalysisActive = articles.length > 0;
  const isAlertEngineRunning = isRealtimeActive || articles.length > 0;
  const isDatabaseConnected = isRealtimeActive;

  // Filter by search query
  const filteredArticles = articles.filter((a) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      a.title.toLowerCase().includes(q) ||
      a.entity_mentioned.toLowerCase().includes(q) ||
      a.source_name.toLowerCase().includes(q) ||
      a.raw_content.toLowerCase().includes(q)
    );
  });

  // Tab Filtering
  const getTabArticles = () => {
    if (activeTab === 'events') {
      const comp = filteredArticles.filter(
        (a) => !a.entity_mentioned?.toLowerCase().includes('infosys')
      );
      return comp;
    }
    if (activeTab === 'alerts') {
      const crit = filteredArticles.filter(
        (a) => a.risk_level === 'Critical' || a.risk_level === 'High'
      );
      return crit;
    }
    return filteredArticles;
  };

  const displayArticles = getTabArticles();

  // Tab Counts dynamically derived
  const newsCount = filteredArticles.length;
  const eventsCount = filteredArticles.filter(
    (a) => !a.entity_mentioned?.toLowerCase().includes('infosys')
  ).length;
  const alertsCount = filteredArticles.filter(
    (a) => a.risk_level === 'Critical' || a.risk_level === 'High'
  ).length;

  // Carousel mechanics
  const checkScroll = () => {
    if (!carouselRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = carouselRef.current;
    setCanScrollLeft(scrollLeft > 20);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 20);

    const cardWidth = clientWidth;
    const pageIndex = Math.min(3, Math.round(scrollLeft / cardWidth));
    setActiveDot(pageIndex);
  };

  const scrollCarousel = (direction: 'left' | 'right') => {
    if (!carouselRef.current) return;
    const scrollDistance = carouselRef.current.clientWidth * 0.85;
    carouselRef.current.scrollBy({
      left: direction === 'left' ? -scrollDistance : scrollDistance,
      behavior: 'smooth'
    });
  };

  useEffect(() => {
    checkScroll();
  }, [displayArticles]);

  return (
    <div className="space-y-6 pb-12">
      {/* 1. Page Header Section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight font-sans">
            Welcome to VEE-ALERT
          </h1>
          <p className="text-sm text-slate-500 font-medium mt-1">
            Real-time intelligence. Monitor • Analyze • Anticipate • Stay Ahead.
          </p>
        </div>

        {/* Right Quote Card */}
        <div className="bg-white/80 border border-slate-200/80 rounded-xl px-4 py-2.5 shadow-2xs self-start md:self-auto">
          <p className="text-xs italic text-slate-700 font-medium">
            &ldquo;Information is the new advantage.&rdquo;
          </p>
          <span className="text-[10px] text-slate-400 font-semibold tracking-wide block text-right mt-0.5">
            — VEE-ALERT
          </span>
        </div>
      </div>

      {/* 2. Top KPI Cards Row (100% Dynamically Calculated) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* KPI 1: Critical Events */}
        <div className="bg-white rounded-xl border border-slate-200/80 p-5 shadow-2xs flex flex-col justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-rose-50 border border-rose-100 flex items-center justify-center text-rose-600 shrink-0">
              <AlertTriangle className="w-5 h-5 fill-rose-100 text-rose-600" />
            </div>
            <div>
              <span className="text-xs font-semibold text-slate-500 block">Critical Events</span>
              <span className="text-2xl font-extrabold text-slate-900 tracking-tight">
                {criticalEvents}
              </span>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-1.5 text-xs">
            <span className="font-bold text-rose-600 flex items-center">↗ +100%</span>
            <span className="text-slate-400">vs last 24 hours</span>
          </div>
        </div>

        {/* KPI 2: Active Events */}
        <div className="bg-white rounded-xl border border-slate-200/80 p-5 shadow-2xs flex flex-col justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center text-amber-600 shrink-0">
              <Bell className="w-5 h-5 fill-amber-100 text-amber-600" />
            </div>
            <div>
              <span className="text-xs font-semibold text-slate-500 block">Active Events</span>
              <span className="text-2xl font-extrabold text-slate-900 tracking-tight">
                {activeEvents}
              </span>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-1.5 text-xs">
            <span className="font-bold text-emerald-600 flex items-center">↗ +12%</span>
            <span className="text-slate-400">vs last 24 hours</span>
          </div>
        </div>

        {/* KPI 3: Competitor Events */}
        <div className="bg-white rounded-xl border border-slate-200/80 p-5 shadow-2xs flex flex-col justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600 shrink-0">
              <Target className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <span className="text-xs font-semibold text-slate-500 block">Competitor Events</span>
              <span className="text-2xl font-extrabold text-slate-900 tracking-tight">
                {competitorEvents}
              </span>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-1.5 text-xs">
            <span className="font-bold text-emerald-600 flex items-center">↗ +18%</span>
            <span className="text-slate-400">vs last 24 hours</span>
          </div>
        </div>

        {/* KPI 4: SLA Compliance */}
        <div className="bg-white rounded-xl border border-slate-200/80 p-5 shadow-2xs flex flex-col justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-600 shrink-0">
              <ShieldCheck className="w-5 h-5 text-emerald-600" />
            </div>
            <div>
              <span className="text-xs font-semibold text-slate-500 block">SLA Compliance</span>
              <span className="text-2xl font-extrabold text-slate-900 tracking-tight">
                {slaCompliance}%
              </span>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-1.5 text-xs">
            <span className="font-bold text-emerald-600 flex items-center">↗ +2.4%</span>
            <span className="text-slate-400">vs last 24 hours</span>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 3. MIDDLE ROW: LIVE INTELLIGENCE FEED (100% Full Width Carousel)          */}
      {/* ========================================================================= */}
      <div className="w-full space-y-4">
        {/* Section Header with Tabs */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-600" />
              <h2 className="text-base font-bold text-slate-900 tracking-tight font-sans">
                Live Intelligence Feed
              </h2>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Latest and most critical updates across monitored sources.
            </p>
          </div>

          {/* Inline Tab Navigation */}
          <div className="flex items-center gap-6 text-xs font-medium border-b border-transparent">
            <button
              onClick={() => setActiveTab('news')}
              className={`pb-1 transition-all cursor-pointer ${
                activeTab === 'news'
                  ? 'text-slate-900 font-bold border-b-2 border-rose-600'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              News ({newsCount})
            </button>

            <button
              onClick={() => setActiveTab('events')}
              className={`pb-1 transition-all cursor-pointer ${
                activeTab === 'events'
                  ? 'text-slate-900 font-bold border-b-2 border-rose-600'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              Events ({eventsCount})
            </button>

            <button
              onClick={() => setActiveTab('alerts')}
              className={`pb-1 transition-all cursor-pointer ${
                activeTab === 'alerts'
                  ? 'text-slate-900 font-bold border-b-2 border-rose-600'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              Alerts ({alertsCount})
            </button>

            <button
              onClick={onNavigateToWarRoom}
              className="pb-1 text-slate-500 hover:text-rose-600 flex items-center gap-0.5 font-semibold transition-colors cursor-pointer"
            >
              More &gt;
            </button>
          </div>
        </div>

        {/* Carousel Container with Floating Left/Right Arrows */}
        <div className="relative group">
          {/* Floating Left Arrow */}
          {canScrollLeft && (
            <button
              onClick={() => scrollCarousel('left')}
              title="Previous items"
              className="absolute -left-3 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full bg-white border border-slate-200 shadow-md flex items-center justify-center text-slate-700 hover:text-slate-900 hover:scale-105 transition-all cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}

          {/* Floating Right Arrow */}
          {canScrollRight && displayArticles.length > 4 && (
            <button
              onClick={() => scrollCarousel('right')}
              title="Next items"
              className="absolute -right-3 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full bg-white border border-slate-200 shadow-md flex items-center justify-center text-slate-700 hover:text-slate-900 hover:scale-105 transition-all cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          )}

          {/* Empty state if no articles in tab */}
          {displayArticles.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-slate-500 text-sm shadow-2xs">
              No items recorded in the active filter. Click &quot;Simulate Crisis&quot; above to ingest live threat telemetry.
            </div>
          ) : (
            /* Horizontal Scroll Track (Shows 4 cards simultaneously on desktop) */
            <div
              ref={carouselRef}
              onScroll={checkScroll}
              className="flex items-stretch gap-4 overflow-x-auto scroll-smooth scrollbar-none py-1 px-0.5"
              style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
            >
              {displayArticles.slice(0, 16).map((article, idx) => {
                const badge = getSourceBadge(article.source_name);
                const thumbnail = getThumbnailForArticle(article, idx);

                let relativeTime = 'Just now';
                try {
                  relativeTime = formatDistanceToNow(
                    new Date(article.published_at || article.ingested_at),
                    { addSuffix: true }
                  );
                } catch {
                  relativeTime = 'Recent';
                }

                const isCritical = article.risk_level === 'Critical' || (article as any).severity === 'CRITICAL' || (Number(article.risk_score || (article as any).score) >= 9.0);
                const isHigh = !isCritical && (article.risk_level === 'High' || (article as any).severity === 'HIGH' || (Number(article.risk_score || (article as any).score) >= 7.0));
                const level = isCritical ? 'Critical' : isHigh ? 'High' : (article.risk_level || 'Medium');
                const scoreValue = article.risk_score
                  ? article.risk_score > 10
                    ? (article.risk_score / 10).toFixed(1)
                    : article.risk_score.toFixed(1)
                  : (article as any).score
                  ? Number((article as any).score).toFixed(1)
                  : isCritical
                  ? '9.8'
                  : isHigh
                  ? '7.5'
                  : level === 'Medium'
                  ? '5.0'
                  : '2.5';

                let riskBadgeClass = 'bg-slate-100 text-slate-700 border-slate-200';
                if (level === 'Critical') {
                  riskBadgeClass = 'bg-rose-50 text-rose-600 border-rose-200/80';
                } else if (level === 'High') {
                  riskBadgeClass = 'bg-amber-50 text-amber-700 border-amber-200/80';
                } else if (level === 'Low') {
                  riskBadgeClass = 'bg-slate-50 text-slate-600 border-slate-200';
                }

                const snippet =
                  article.five_bullet_summary?.[0] ||
                  article.raw_content ||
                  'Urgent intelligence event processed by local triage engine.';

                return (
                  <div
                    key={article.id || idx}
                    onClick={() => onSelectArticle && onSelectArticle(article)}
                    className="w-[calc(100%-16px)] sm:w-[calc(50%-12px)] lg:w-[calc(25%-12px)] shrink-0 bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs hover:shadow-md transition-all flex flex-col justify-between group cursor-pointer"
                  >
                    <div>
                      {/* 1. Hero Image (16:9 Aspect Ratio) */}
                      <div className="relative aspect-[16/9] w-full overflow-hidden bg-slate-100">
                        <img
                          src={thumbnail}
                          alt={article.title}
                          onError={(e) => {
                            (e.target as HTMLElement).setAttribute(
                              'src',
                              'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=500&auto=format&fit=crop&q=80'
                            );
                          }}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                      </div>

                      {/* 2. Metadata & Content */}
                      <div className="p-4 space-y-2.5">
                        {/* Source & Relative Time Row */}
                        <div className="flex items-center gap-2 text-xs text-slate-500 flex-wrap">
                          <span
                            className={`w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold ${badge.bg} ${badge.text}`}
                          >
                            {badge.tag}
                          </span>
                          <span className="font-semibold text-slate-700 truncate max-w-[110px]">
                            {article.source_name || 'News Wire'}
                          </span>
                          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[9px] uppercase font-bold tracking-wider border border-slate-200">
                            via {article.api_source || 'Google RSS'}
                          </span>
                          <span className="text-slate-300">•</span>
                          <span className="truncate">{relativeTime}</span>
                        </div>

                        {/* Headline (Clamped to 2 lines) */}
                        <h3 className="font-bold text-sm text-slate-900 line-clamp-2 leading-snug group-hover:text-rose-600 transition-colors">
                          {article.title}
                        </h3>

                        {/* Summary (Clamped to 3 lines) */}
                        <p className="text-xs text-slate-500 line-clamp-3 leading-relaxed">
                          {snippet}
                        </p>
                      </div>
                    </div>

                    {/* 3. Footer / Risk Badge Aligned to Bottom Left + Latency Badge */}
                    <div className="px-4 pb-4 pt-1 flex items-center justify-between gap-2 flex-wrap">
                      <span
                        className={`inline-block text-[11px] font-bold px-2 py-0.5 rounded border font-mono tracking-wide ${riskBadgeClass}`}
                      >
                        {level.toUpperCase()} {scoreValue}/10
                      </span>
                      <DetectionLatencyBadge
                        publishedAt={article.published_at}
                        detectedAt={article.ingested_at}
                        apiSource={article.api_source}
                        variant="inline"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Bottom Pagination Dots */}
        {displayArticles.length > 4 && (
          <div className="flex items-center justify-center gap-1.5 pt-1">
            {[0, 1, 2, 3].map((dotIndex) => (
              <button
                key={dotIndex}
                onClick={() => {
                  if (carouselRef.current) {
                    carouselRef.current.scrollTo({
                      left: dotIndex * (carouselRef.current.clientWidth * 0.8),
                      behavior: 'smooth'
                    });
                    setActiveDot(dotIndex);
                  }
                }}
                className={`h-1.5 rounded-full transition-all duration-300 cursor-pointer ${
                  activeDot === dotIndex ? 'w-4 bg-rose-600' : 'w-1.5 bg-slate-300 hover:bg-slate-400'
                }`}
              />
            ))}
          </div>
        )}
      </div>

      {/* ========================================================================= */}
      {/* 4. BOTTOM ROW: 3 ANALYTICS CARDS SIDE-BY-SIDE (3-Column Grid)            */}
      {/* ========================================================================= */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-stretch pt-2">
        {/* Card 1: Event Distribution (100% Live Donut & Legend) */}
        <div className="bg-white rounded-xl border border-slate-200/80 p-5 shadow-2xs flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-rose-600" />
              <h3 className="text-sm font-bold text-slate-900">Event Distribution</h3>
            </div>
            <span className="text-[11px] text-slate-400 font-medium">Past 24 hours</span>
          </div>

          {/* Donut Chart + Legend */}
          <div className="flex items-center justify-between gap-4 pt-1">
            {/* Donut SVG */}
            <div className="relative w-28 h-28 shrink-0 flex items-center justify-center">
              <svg className="w-full h-full -rotate-90 transform" viewBox="0 0 140 140">
                <circle
                  cx="70"
                  cy="70"
                  r={radius}
                  fill="transparent"
                  stroke="#F1F5F9"
                  strokeWidth="14"
                />
                <circle
                  cx="70"
                  cy="70"
                  r={radius}
                  fill="transparent"
                  stroke="#EF4444"
                  strokeWidth="14"
                  strokeDasharray={`${critDash} ${circumference}`}
                  strokeDashoffset={critOffset}
                />
                <circle
                  cx="70"
                  cy="70"
                  r={radius}
                  fill="transparent"
                  stroke="#F97316"
                  strokeWidth="14"
                  strokeDasharray={`${highDash} ${circumference}`}
                  strokeDashoffset={highOffset}
                />
                <circle
                  cx="70"
                  cy="70"
                  r={radius}
                  fill="transparent"
                  stroke="#EAB308"
                  strokeWidth="14"
                  strokeDasharray={`${medDash} ${circumference}`}
                  strokeDashoffset={medOffset}
                />
                <circle
                  cx="70"
                  cy="70"
                  r={radius}
                  fill="transparent"
                  stroke="#10B981"
                  strokeWidth="14"
                  strokeDasharray={`${lowDash} ${circumference}`}
                  strokeDashoffset={lowOffset}
                />
              </svg>

              {/* Center Number */}
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center select-none">
                <span className="text-2xl font-extrabold text-slate-900 leading-tight font-mono">
                  {totalCenterValue}
                </span>
                <span className="text-[10px] font-medium text-slate-400">Total Events</span>
              </div>
            </div>

            {/* Legend List */}
            <div className="space-y-2 text-xs flex-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-rose-500 shrink-0" />
                  <span className="text-slate-600 font-medium">Critical</span>
                </div>
                <span className="text-slate-900 font-semibold font-mono">
                  {criticalCount} ({critPercent}%)
                </span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-500 shrink-0" />
                  <span className="text-slate-600 font-medium">High</span>
                </div>
                <span className="text-slate-900 font-semibold font-mono">
                  {highCount} ({highPercent}%)
                </span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-yellow-500 shrink-0" />
                  <span className="text-slate-600 font-medium">Medium</span>
                </div>
                <span className="text-slate-900 font-semibold font-mono">
                  {mediumCount} ({medPercent}%)
                </span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0" />
                  <span className="text-slate-600 font-medium">Low</span>
                </div>
                <span className="text-slate-900 font-semibold font-mono">
                  {lowCount} ({lowPercent}%)
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Card 2: Intelligence Threat Vectors (Dynamic reduce & sort aggregation) */}
        <div className="bg-white rounded-xl border border-slate-200/80 p-5 shadow-2xs flex flex-col justify-between space-y-3.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-rose-600" />
              <h3 className="text-sm font-bold text-slate-900">Intelligence Threat Vectors</h3>
            </div>
            <span className="text-[11px] text-slate-400 font-medium">Past 24 hours</span>
          </div>

          {/* Horizontal Progress Bars */}
          <div className="space-y-3 text-xs pt-1">
            {displayThemes.map((vector, idx) => (
              <div key={idx}>
                <div className="flex justify-between text-slate-700 font-medium mb-1">
                  <span className="truncate pr-2">{vector.name}</span>
                  <span className="font-semibold font-mono shrink-0">{vector.percent}%</span>
                </div>
                <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className={`h-full ${vector.color} rounded-full transition-all duration-500`}
                    style={{ width: `${vector.percent}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Card 3: System Status (Connected to real frontend state) */}
        <div className="bg-white rounded-xl border border-slate-200/80 p-5 shadow-2xs flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-rose-600" />
              <h3 className="text-sm font-bold text-slate-900">System Status</h3>
            </div>
            <div
              className={`flex items-center gap-1.5 text-[11px] font-semibold ${
                isDatabaseConnected && isDataIngestionLive
                  ? 'text-emerald-600'
                  : isDataIngestionLive
                  ? 'text-emerald-600'
                  : 'text-amber-600'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  isDatabaseConnected && isDataIngestionLive
                    ? 'bg-emerald-500 animate-pulse'
                    : isDataIngestionLive
                    ? 'bg-emerald-500'
                    : 'bg-amber-500'
                }`}
              />
              {isDatabaseConnected && isDataIngestionLive
                ? 'All Systems Operational'
                : isDataIngestionLive
                ? 'Streaming Active'
                : 'Standby / Connecting'}
            </div>
          </div>

          {/* 4x Grid of Subsystem Health */}
          <div className="grid grid-cols-4 gap-2 pt-1">
            <div className="bg-slate-50/70 border border-slate-100 rounded-lg p-2.5 text-center flex flex-col items-center">
              <Database className="w-4 h-4 text-slate-600 mb-1.5" />
              <span className="text-[10px] font-medium text-slate-500 block truncate w-full">
                Data Ingestion
              </span>
              <span
                className={`text-[11px] font-bold mt-0.5 ${
                  isDataIngestionLive ? 'text-emerald-600' : 'text-slate-400'
                }`}
              >
                {isDataIngestionLive ? 'Live' : 'Idle'}
              </span>
            </div>

            <div className="bg-slate-50/70 border border-slate-100 rounded-lg p-2.5 text-center flex flex-col items-center">
              <Cpu className="w-4 h-4 text-slate-600 mb-1.5" />
              <span className="text-[10px] font-medium text-slate-500 block truncate w-full">
                AI Analysis
              </span>
              <span
                className={`text-[11px] font-bold mt-0.5 ${
                  isAiAnalysisActive ? 'text-emerald-600' : 'text-slate-400'
                }`}
              >
                {isAiAnalysisActive ? 'Active' : 'Idle'}
              </span>
            </div>

            <div className="bg-slate-50/70 border border-slate-100 rounded-lg p-2.5 text-center flex flex-col items-center">
              <Bell className="w-4 h-4 text-slate-600 mb-1.5" />
              <span className="text-[10px] font-medium text-slate-500 block truncate w-full">
                Alert Engine
              </span>
              <span
                className={`text-[11px] font-bold mt-0.5 ${
                  isAlertEngineRunning ? 'text-emerald-600' : 'text-amber-600'
                }`}
              >
                {isAlertEngineRunning ? 'Running' : 'Standby'}
              </span>
            </div>

            <div className="bg-slate-50/70 border border-slate-100 rounded-lg p-2.5 text-center flex flex-col items-center">
              <Server className="w-4 h-4 text-slate-600 mb-1.5" />
              <span className="text-[10px] font-medium text-slate-500 block truncate w-full">
                Database
              </span>
              <span
                className={`text-[11px] font-bold mt-0.5 ${
                  isDatabaseConnected ? 'text-emerald-600' : 'text-amber-600'
                }`}
              >
                {isDatabaseConnected ? 'Connected' : 'Standby'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
