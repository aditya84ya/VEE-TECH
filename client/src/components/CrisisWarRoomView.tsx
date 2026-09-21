import React, { useState, useMemo, useEffect, useRef } from 'react';
import axios from 'axios';
import { formatDistanceToNow } from 'date-fns';
import {
  PhoneCall,
  Check,
  ExternalLink,
  ShieldAlert,
  Clock,
  Newspaper,
  ChevronDown,
  ChevronUp,
  Search,
  SlidersHorizontal,
  TrendingUp,
  Activity,
  CheckCircle2,
  Server,
  Database,
  Cpu,
  Radio,
  ArrowDown,
  Image as ImageIcon,
  FileText,
  AlertTriangle
} from 'lucide-react';
import { Article } from '../hooks/useWarRoom';
import { DetectionLatencyBadge } from './DetectionLatencyBadge';
import { ArticleLifecycleTimeline } from './ArticleLifecycleTimeline';
import { calculateAggregateLatencyMetrics, calculateSplitLatencyMetrics } from '../utils/detectionLatency';

const API_BASE_URL = (import.meta.env?.VITE_API_BASE_URL || 'http://localhost:5000').replace(/\/$/, '');

interface CrisisWarRoomViewProps {
  articles: Article[];
  onAcknowledge: (id: string) => void;
  onEscalateVoice: (article: Article) => void;
  loading: boolean;
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
  if (s.includes('guardian')) {
    return { tag: 'GU', bg: 'bg-[#052962]', text: 'text-white' };
  }
  if (s.includes('market') || s.includes('trader')) {
    return { tag: 'MK', bg: 'bg-[#1E40AF]', text: 'text-white' };
  }
  return {
    tag: sourceName ? sourceName.slice(0, 2).toUpperCase() : 'NW',
    bg: 'bg-slate-700',
    text: 'text-white'
  };
};

// High-fidelity fallback imagery if RSS feed did not deliver an og:image tag
const getThumbnailForArticle = (article: Article, index: number): string => {
  if (article.image_url && String(article.image_url).startsWith('http')) {
    return article.image_url;
  }
  const text = `${article.title} ${article.entity_mentioned} ${article.raw_content}`.toLowerCase();

  // 1. Semiconductor / Hardware / AI Chip
  if (text.includes('semiconductor') || text.includes('chip') || text.includes('hardware')) {
    return 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=500&auto=format&fit=crop&q=80';
  }
  // 2. TCS Facility / Campus
  if (text.includes('tcs') || text.includes('tata consultancy') || text.includes('tata')) {
    return 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=500&auto=format&fit=crop&q=80';
  }
  // 3. Wipro Corporate Office
  if (text.includes('wipro') || text.includes('sto360') || text.includes('aramco')) {
    return 'https://images.unsplash.com/photo-1497215728101-856f4ea42174?w=500&auto=format&fit=crop&q=80';
  }
  // 4. Accenture Enterprise
  if (text.includes('accenture') || text.includes('guggenheim') || text.includes('downgrade')) {
    return 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=500&auto=format&fit=crop&q=80';
  }
  // 5. Infosys Campus / Building / Finacle Banking
  if (text.includes('infosys') || text.includes('finacle') || text.includes('banking') || text.includes('audit')) {
    return index % 2 === 0
      ? 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=500&auto=format&fit=crop&q=80'
      : 'https://images.unsplash.com/photo-1554469384-e58fac16e23a?w=500&auto=format&fit=crop&q=80';
  }
  // 6. Markets / Stocks / Trading
  if (text.includes('stock') || text.includes('shares') || text.includes('earnings') || text.includes('nifty')) {
    return 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=500&auto=format&fit=crop&q=80';
  }
  // 7. Real Estate / Housing
  if (text.includes('housing') || text.includes('redevelopment') || text.includes('mumbai') || text.includes('puravankara')) {
    return 'https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=500&auto=format&fit=crop&q=80';
  }
  // Default Enterprise Tech
  return 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=500&auto=format&fit=crop&q=80';
};

export const CrisisWarRoomView: React.FC<CrisisWarRoomViewProps> = ({
  articles,
  onAcknowledge,
  onEscalateVoice,
  loading
}) => {
  // Primary Tabs Filter: 'all' | 'critical' | 'infosys' | 'visual_ocr'
  const [primaryFilter, setPrimaryFilter] = useState<'all' | 'critical' | 'infosys' | 'visual_ocr'>('all');

  // Secondary Filter States
  const [searchFilter, setSearchFilter] = useState('');
  const [severityFilter, setSeverityFilter] = useState('ALL');
  const [targetFilter, setTargetFilter] = useState('ALL');
  const [sourceFilter, setSourceFilter] = useState('All');
  const [timeFilter, setTimeFilter] = useState('All');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest' | 'fastest' | 'slowest'>('newest');

  // Discrete state arrays & query handlers for CSE and RSS independent feeds
  const [cseArticles, setCseArticles] = useState<Article[]>([]);
  const [isCseLoading, setIsCseLoading] = useState<boolean>(false);
  const [rssArticles, setRssArticles] = useState<Article[]>([]);
  const [isRssLoading, setIsRssLoading] = useState<boolean>(false);

  // Dedicated source filter handler mapping dropdown selections to backend stream routes
  const handleSourceFilterChange = async (selectedSource: string) => {
    setSourceFilter(selectedSource);

    if (selectedSource === 'Google Search Engine (CSE)' || selectedSource === 'Google CSE') {
      setIsCseLoading(true);
      try {
        const response = await axios.get(`${API_BASE_URL}/api/fetch-cse-stream`);
        const items = Array.isArray(response.data)
          ? response.data
          : (response.data?.articles || []);
        setCseArticles(items);
      } catch (err: any) {
        console.error('[CrisisWarRoomView] Failed to fetch live Google CSE stream:', err.message);
      } finally {
        setIsCseLoading(false);
      }
    } else if (selectedSource === 'Google News RSS' || selectedSource === 'Google News RSS (Verified Wire)') {
      setIsRssLoading(true);
      try {
        const response = await axios.get(`${API_BASE_URL}/api/fetch-rss-stream`);
        const items = Array.isArray(response.data)
          ? response.data
          : (response.data?.articles || []);
        if (items.length > 0) {
          setRssArticles(items);
        }
      } catch (err: any) {
        console.warn('[CrisisWarRoomView] Using aggregated cache for RSS wire:', err.message);
      } finally {
        setIsRssLoading(false);
      }
    }
  };

  // Expanded intelligence briefs state (mapped by article ID)
  const [expandedBriefs, setExpandedBriefs] = useState<Record<string, boolean>>({});

  // Expanded article summaries state (for [Read more] / [Show less] inline toggle)
  const [expandedSummaries, setExpandedSummaries] = useState<Record<string, boolean>>({});

  const toggleSummary = (articleId: string) => {
    setExpandedSummaries((prev) => ({
      ...prev,
      [articleId]: !prev[articleId]
    }));
  };

  // Expanded article headlines state (for [Read more] / [Show less] inline toggle)
  const [expandedHeadlines, setExpandedHeadlines] = useState<Record<string, boolean>>({});

  const toggleHeadline = (articleId: string) => {
    setExpandedHeadlines((prev) => ({
      ...prev,
      [articleId]: !prev[articleId]
    }));
  };

  // Real-time new events notification tracking
  const [scrolledDown, setScrolledDown] = useState(false);
  const [unseenCount, setUnseenCount] = useState(0);
  const previousArticlesCount = useRef(articles.length);

  // Real-time link validation state & session cache
  const [unreachableUrls, setUnreachableUrls] = useState<Set<string>>(() => new Set());
  const checkedUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const urlsToCheck: string[] = [];
    for (const a of articles) {
      if (a.url && !checkedUrlsRef.current.has(a.url)) {
        urlsToCheck.push(a.url);
        checkedUrlsRef.current.add(a.url);
      }
    }

    if (urlsToCheck.length === 0) return;

    let isMounted = true;
    axios
      .post(`${API_BASE_URL}/api/validate-link`, { urls: urlsToCheck })
      .then((res) => {
        if (!isMounted) return;
        const results = res.data?.results || {};
        setUnreachableUrls((prev) => {
          const next = new Set(prev);
          for (const [u, reachable] of Object.entries(results)) {
            if (reachable === false) {
              next.add(u);
            }
          }
          return next;
        });
      })
      .catch((err) => {
        console.warn('[CrisisWarRoomView] Link validation check notice:', err.message);
      });

    return () => {
      isMounted = false;
    };
  }, [articles]);

  // Track window scrolling to display floating "New Events Detected" pill
  useEffect(() => {
    const handleScroll = () => {
      const isDown = window.scrollY > 250;
      setScrolledDown(isDown);
      if (!isDown) {
        setUnseenCount(0);
      }
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Detect newly arriving WebSocket articles while scrolled down
  useEffect(() => {
    if (articles.length > previousArticlesCount.current) {
      const added = articles.length - previousArticlesCount.current;
      if (scrolledDown) {
        setUnseenCount((prev) => prev + added);
      }
    }
    previousArticlesCount.current = articles.length;
  }, [articles.length, scrolledDown]);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setUnseenCount(0);
  };

  const toggleBrief = (id: string) => {
    setExpandedBriefs((prev) => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

  const clearAllFilters = () => {
    setPrimaryFilter('all');
    setSearchFilter('');
    setSeverityFilter('ALL');
    setTargetFilter('ALL');
    setSourceFilter('All');
    setTimeFilter('All');
    setSortOrder('newest');
  };

  // Derive unique entities and sources for dropdowns
  const availableEntities = useMemo(() => {
    const set = new Set<string>();
    articles.forEach((a) => {
      if (a.entity_mentioned) set.add(a.entity_mentioned);
    });
    return Array.from(set).sort();
  }, [articles]);

  const availableSources = useMemo(() => {
    const set = new Set<string>();
    articles.forEach((a) => {
      if (a.source_name) set.add(a.source_name);
    });
    return Array.from(set).sort();
  }, [articles]);

  // Main filtered & sorted stream with dedicated source arrays
  const filteredArticles = useMemo(() => {
    const isCseSource = sourceFilter === 'Google Search Engine (CSE)' || sourceFilter === 'Google CSE';
    const isRssSource = sourceFilter === 'Google News RSS' || sourceFilter === 'Google News RSS (Verified Wire)';

    // Swap underlying data array based on selected source
    let sourceStream: Article[];
    if (isCseSource) {
      sourceStream = cseArticles;
    } else if (isRssSource) {
      sourceStream = rssArticles.length > 0 ? rssArticles : articles.filter(a => {
        const apiSrc = (a.api_source || '').toLowerCase();
        return (apiSrc.includes('google') || apiSrc.includes('rss')) && !apiSrc.includes('cse') && !apiSrc.includes('institutional') && !apiSrc.includes('publisher');
      });
    } else {
      sourceStream = articles;
    }

    return sourceStream
      .filter((article) => {
        // Primary pill
        if (primaryFilter === 'critical') {
          const isCrit = article.risk_level === 'Critical' || (article as any).severity === 'CRITICAL' || (Number(article.risk_score || (article as any).score) >= 9.0);
          if (!isCrit) return false;
        }
        if (primaryFilter === 'infosys' && !article.entity_mentioned?.toLowerCase().includes('infosys')) return false;
        if (primaryFilter === 'visual_ocr') {
          const apiSrc = (article.api_source || '').toLowerCase();
          const srcName = (article.source_name || '').toLowerCase();
          const isOcr =
            apiSrc.includes('epaper') || apiSrc.includes('ocr') ||
            srcName.includes('ocr') || srcName.includes('e-paper') || srcName.includes('pdf') ||
            article.ocrConfidence !== undefined || article.isLowConfidence === true ||
            Boolean((article as any).metadata?.ocr_confidence) ||
            Boolean((article as any).metadata?.original_media_url);
          if (!isOcr) return false;
        }

        // Secondary search
        if (searchFilter.trim()) {
          const q = searchFilter.toLowerCase();
          const matches =
            article.title.toLowerCase().includes(q) ||
            article.entity_mentioned?.toLowerCase().includes(q) ||
            article.source_name?.toLowerCase().includes(q) ||
            article.raw_content?.toLowerCase().includes(q);
          if (!matches) return false;
        }

        // Secondary severity
        if (severityFilter !== 'ALL') {
          const currentLevel = (article.risk_level === 'Critical' || (article as any).severity === 'CRITICAL' || Number(article.risk_score || (article as any).score) >= 9.0)
            ? 'Critical'
            : (article.risk_level === 'High' || (article as any).severity === 'HIGH' || Number(article.risk_score || (article as any).score) >= 7.0)
              ? 'High'
              : (article.risk_level || 'Medium');
          if (currentLevel !== severityFilter) return false;
        }

        // Secondary target
        if (targetFilter !== 'ALL' && article.entity_mentioned !== targetFilter) return false;

        // Secondary source (strictly filters by high-level ingestion engine / api_source for non-CSE / non-RSS)
        if (!isCseSource && !isRssSource && sourceFilter !== 'All' && sourceFilter !== 'ALL') {
          const apiSrc = (article.api_source || '').toLowerCase();
          if (sourceFilter === 'NewsAPI') {
            if (!apiSrc.includes('newsapi')) return false;
          } else if (sourceFilter === 'Currents API') {
            if (!apiSrc.includes('currents')) return false;
          } else if (sourceFilter === 'GNews') {
            if (!apiSrc.includes('gnews')) return false;
          } else if (sourceFilter === 'NewsData') {
            if (!apiSrc.includes('newsdata')) return false;
          } else if (sourceFilter === 'The Guardian') {
            if (!apiSrc.includes('guardian')) return false;
          } else if (sourceFilter === 'Bluesky Social') {
            if (!apiSrc.includes('bluesky')) return false;
          } else if (sourceFilter === 'GDELT DOC') {
            if (!apiSrc.includes('gdelt')) return false;
          } else if (sourceFilter === 'E-Paper OCR') {
            if (!apiSrc.includes('epaper') && !apiSrc.includes('ocr')) return false;
          } else if (sourceFilter === 'Institutional') {
            if (!apiSrc.includes('institutional') && !apiSrc.includes('et') && !apiSrc.includes('publisher')) return false;
          }
        }

        // Secondary time filter based on when the news event was published
        const now = Date.now();
        let matchesTime = true;

        if (timeFilter !== 'All') {
          const articleTime = new Date(article.published_at || article.ingested_at).getTime();
          const diffHours = (now - articleTime) / (1000 * 60 * 60);

          if (timeFilter === '1h') matchesTime = diffHours <= 1;
          else if (timeFilter === '24h') matchesTime = diffHours <= 24;
          else if (timeFilter === '7d') matchesTime = diffHours <= 168;
        }

        return matchesTime;
      })
      .sort((a, b) => {
        if (sortOrder === 'fastest') {
          const pubA = a.published_at ? new Date(a.published_at).getTime() : 0;
          const detA = a.ingested_at ? new Date(a.ingested_at).getTime() : 0;
          const latA = detA > 0 && pubA > 0 && detA >= pubA ? detA - pubA : Infinity;

          const pubB = b.published_at ? new Date(b.published_at).getTime() : 0;
          const detB = b.ingested_at ? new Date(b.ingested_at).getTime() : 0;
          const latB = detB > 0 && pubB > 0 && detB >= pubB ? detB - pubB : Infinity;

          return latA - latB;
        }
        if (sortOrder === 'slowest') {
          const pubA = a.published_at ? new Date(a.published_at).getTime() : 0;
          const detA = a.ingested_at ? new Date(a.ingested_at).getTime() : 0;
          const latA = detA > 0 && pubA > 0 && detA >= pubA ? detA - pubA : -1;

          const pubB = b.published_at ? new Date(b.published_at).getTime() : 0;
          const detB = b.ingested_at ? new Date(b.ingested_at).getTime() : 0;
          const latB = detB > 0 && pubB > 0 && detB >= pubB ? detB - pubB : -1;

          return latB - latA;
        }
        // Sort by the exact millisecond Vee-Alert ingested it
        const timeA = new Date(a.ingested_at || a.published_at).getTime();
        const timeB = new Date(b.ingested_at || b.published_at).getTime();
        if (sortOrder === 'oldest') {
          return timeA - timeB;
        }
        return timeB - timeA; // Descending (newest)
      });
  }, [articles, primaryFilter, searchFilter, severityFilter, targetFilter, sourceFilter, timeFilter, sortOrder, cseArticles, rssArticles]);

  // Sidebar Analytics: Live Overview metrics
  const totalEvents = articles.length;
  const criticalCount = articles.filter((a) => a.risk_level === 'Critical' || (a as any).severity === 'CRITICAL' || (Number(a.risk_score || (a as any).score) >= 9.0)).length;
  const highCount = articles.filter((a) => !((a.risk_level === 'Critical' || (a as any).severity === 'CRITICAL' || (Number(a.risk_score || (a as any).score) >= 9.0))) && (a.risk_level === 'High' || (a as any).severity === 'HIGH' || (Number(a.risk_score || (a as any).score) >= 7.0))).length;
  const othersCount = Math.max(0, totalEvents - criticalCount - highCount);

  // Visual/OCR tab badge count
  const visualOcrCount = useMemo(() => {
    return articles.filter(a => {
      const apiSrc = (a.api_source || '').toLowerCase();
      const srcName = (a.source_name || '').toLowerCase();
      return (
        apiSrc.includes('epaper') || apiSrc.includes('ocr') ||
        srcName.includes('ocr') || srcName.includes('e-paper') || srcName.includes('pdf') ||
        a.ocrConfidence !== undefined || a.isLowConfidence === true ||
        Boolean((a as any).metadata?.ocr_confidence) ||
        Boolean((a as any).metadata?.original_media_url)
      );
    }).length;
  }, [articles]);

  // Detection Performance aggregate metrics across real timestamps in operational live window
  const latencyMetrics = useMemo(() => {
    return calculateAggregateLatencyMetrics(articles, {
      maxLatencyHours: 24,
      publishedWithinHours: 24,
      scopeLabel: 'Last 24 hours'
    });
  }, [articles]);

  // Detection Performance split metrics: Push (WebSocket) vs Polled/Aggregated (RSS/APIs)
  const splitLatency = useMemo(() => {
    return calculateSplitLatencyMetrics(articles, {
      maxLatencyHours: 24,
      publishedWithinHours: 24,
      scopeLabel: 'Last 24 hours'
    });
  }, [articles]);

  // Section 29: Development-Only Diagnostics Logging
  useEffect(() => {
    if (import.meta.env?.DEV) {
      const lowCount = articles.filter((a) => a.risk_level === 'Low').length;
      const mediumCount = articles.filter((a) => a.risk_level === 'Medium').length;
      console.log('\n--- [VEE-ALERT CRISIS WAR ROOM: LIVE DATA REFRESH] ---');
      console.log(`Fetched / Total Events: ${articles.length}`);
      console.log(`Severity Breakdown: Critical: ${criticalCount}, High: ${highCount}, Medium: ${mediumCount}, Low: ${lowCount}`);
      console.log(`Live Velocity Evaluated: ${latencyMetrics.count} valid live articles (Avg: ${latencyMetrics.formattedAverage}, P95: ${latencyMetrics.formattedP95})`);
      console.log(`Anomalies Excluded: ${latencyMetrics.anomalyCount}, Archival Records Excluded: ${latencyMetrics.archivalCount}`);
      console.log('------------------------------------------------------\n');
    }
  }, [articles.length, criticalCount, highCount, latencyMetrics]);

  // Sidebar Analytics: Targets under watch
  const targetCounts = useMemo(() => {
    const counts: Record<string, number> = {
      Infosys: 0,
      TCS: 0,
      Wipro: 0,
      Accenture: 0
    };
    articles.forEach((a) => {
      const ent = a.entity_mentioned;
      if (ent && counts[ent] !== undefined) {
        counts[ent]++;
      } else if (ent) {
        counts[ent] = (counts[ent] || 0) + 1;
      }
    });
    return counts;
  }, [articles]);

  if (loading && articles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-slate-400">
        <div className="w-8 h-8 border-2 border-rose-600 border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-sm font-medium text-slate-600">Connecting to Supabase Realtime Crisis Stream...</p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[1600px] mx-auto pb-16 space-y-6">
      {/* Floating New Events Notification Toast */}
      {unseenCount > 0 && scrolledDown && (
        <button
          onClick={scrollToTop}
          className="fixed top-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 bg-slate-950 text-white border border-slate-800 rounded-full shadow-xl text-xs font-semibold hover:bg-slate-900 transition-all cursor-pointer animate-bounce"
        >
          <ArrowDown className="w-3.5 h-3.5 text-rose-500" />
          <span>↓ {unseenCount} New Incoming Events</span>
        </button>
      )}

      {/* 1. Page Header & Live Badge */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200/80 pb-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight font-sans">
              Crisis War Room Feed
            </h1>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              LIVE
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Real-time event stream triaged in-memory with sub-120 second SLA guarantee.
          </p>
        </div>

        {/* Primary Filter Pills */}
        <div className="flex items-center gap-1 bg-white border border-slate-200 p-1 rounded-lg shadow-2xs self-start md:self-auto">
          <button
            onClick={() => setPrimaryFilter('all')}
            className={`px-3.5 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${primaryFilter === 'all'
              ? 'bg-slate-900 text-white shadow-2xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
          >
            All Stream ({articles.length})
          </button>
          <button
            onClick={() => setPrimaryFilter('critical')}
            className={`px-3.5 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${primaryFilter === 'critical'
              ? 'bg-slate-900 text-white shadow-2xs'
              : 'text-slate-600 hover:text-rose-600 hover:bg-rose-50'
              }`}
          >
            Critical Only ({criticalCount})
          </button>
          <button
            onClick={() => setPrimaryFilter('infosys')}
            className={`px-3.5 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${primaryFilter === 'infosys'
              ? 'bg-slate-900 text-white shadow-2xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
          >
            Infosys Only ({targetCounts.Infosys || 0})
          </button>
          <button
            onClick={() => setPrimaryFilter('visual_ocr')}
            className={`px-3.5 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer flex items-center gap-1 ${primaryFilter === 'visual_ocr'
              ? 'bg-emerald-700 text-white shadow-2xs'
              : 'text-slate-600 hover:text-emerald-700 hover:bg-emerald-50'
              }`}
          >
            <ImageIcon className="w-3 h-3" />
            Images / E-Paper ({visualOcrCount})
          </button>
        </div>
      </div>

      {/* 2. Secondary Filter Bar (Compact dropdowns) */}
      <div className="bg-white border border-slate-200/90 rounded-xl p-3 shadow-2xs flex flex-wrap items-center gap-3 text-xs">
        {/* Search input */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            placeholder="Search events, sources, targets..."
            className="w-full h-8 pl-8 pr-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400"
          />
        </div>

        {/* Severity dropdown */}
        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value)}
          className="h-8 px-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 font-medium focus:outline-none cursor-pointer"
        >
          <option value="ALL">Severity: All</option>
          <option value="Critical">Critical</option>
          <option value="High">High</option>
          <option value="Medium">Medium</option>
          <option value="Low">Low</option>
        </select>

        {/* Target dropdown */}
        <select
          value={targetFilter}
          onChange={(e) => setTargetFilter(e.target.value)}
          className="h-8 px-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 font-medium focus:outline-none cursor-pointer max-w-[150px]"
        >
          <option value="ALL">Target: All</option>
          {availableEntities.map((ent) => (
            <option key={ent} value={ent}>
              {ent}
            </option>
          ))}
        </select>

        {/* Source dropdown */}
        <select
          value={sourceFilter}
          onChange={(e) => handleSourceFilterChange(e.target.value)}
          className="bg-slate-50 border border-slate-200 text-slate-700 text-sm rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-rose-500 transition-all cursor-pointer"
        >
          <option value="All">Source: All</option>
          <option value="Google News RSS">Google News RSS (Verified Wire)</option>
          <option value="Google Search Engine (CSE)">Google Search Engine (CSE)</option>
          <option value="Institutional">Institutional Publisher Wires (ET, Mint, BS)</option>
          <option value="NewsAPI">NewsAPI (Global Aggregator)</option>
          <option value="Currents API">Currents Global News</option>
          <option value="GNews">GNews AI-Curated Wire</option>
          <option value="NewsData">NewsData Archive</option>
          <option value="The Guardian">The Guardian API</option>
          <option value="Bluesky Social">Bluesky Social (Trial)</option>
          <option value="GDELT DOC">GDELT DOC 2.0 (Standby)</option>
          <option value="E-Paper OCR">E-Paper / Image OCR</option>
        </select>

        {/* Time dropdown */}
        <select
          value={timeFilter}
          onChange={(e) => setTimeFilter(e.target.value)}
          className="bg-slate-50 border border-slate-200 text-slate-700 text-sm rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-rose-500 transition-all"
        >
          <option value="All">Time: All</option>
          <option value="1h">Past 1 Hour</option>
          <option value="24h">Past 24 Hours</option>
          <option value="7d">Past 7 Days</option>
        </select>

        {/* Sort order */}
        <select
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value as 'newest' | 'oldest' | 'fastest' | 'slowest')}
          className="h-8 px-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 font-medium focus:outline-none cursor-pointer"
        >
          <option value="newest">Sort: Newest Detected</option>
          <option value="oldest">Sort: Oldest Detected</option>
          <option value="fastest">Sort: Fastest Detection</option>
          <option value="slowest">Sort: Slowest Detection</option>
        </select>

        {/* Clear All */}
        <button
          onClick={clearAllFilters}
          className="h-8 px-2.5 text-rose-600 hover:text-rose-700 hover:bg-rose-50 rounded-lg font-semibold transition-colors cursor-pointer ml-auto"
        >
          Clear All
        </button>
      </div>

      {/* 3. 75% / 25% Two-Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* ========================================================= */}
        {/* LEFT COLUMN: Event Stream (~75% -> col-span-8 or 9) */}
        {/* ========================================================= */}
        <div className="lg:col-span-9 space-y-4 min-w-0">
          {isCseLoading ? (
            <div className="text-center py-16 bg-white border border-blue-200 rounded-xl p-8 shadow-xs">
              <div className="w-8 h-8 border-3 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-3" />
              <p className="text-base font-semibold text-slate-800">
                Querying Google Programmable Search Engine (CSE)...
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Fetching dedicated live search JSON results from /api/fetch-cse-stream
              </p>
            </div>
          ) : isRssLoading ? (
            <div className="text-center py-16 bg-white border border-emerald-200 rounded-xl p-8 shadow-xs">
              <div className="w-8 h-8 border-3 border-emerald-200 border-t-emerald-600 rounded-full animate-spin mx-auto mb-3" />
              <p className="text-base font-semibold text-slate-800">
                Fetching Google News RSS Stream...
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Querying dedicated verified RSS feed from /api/fetch-rss-stream
              </p>
            </div>
          ) : filteredArticles.length === 0 ? (
            <div className="text-center py-16 bg-white border border-slate-200/80 rounded-xl p-8 shadow-2xs">
              <ShieldAlert className="w-10 h-10 text-slate-400 mx-auto mb-3" />
              <p className="text-base font-semibold text-slate-800">
                {primaryFilter === 'critical'
                  ? 'No active critical incidents matching filters'
                  : primaryFilter === 'infosys'
                    ? 'No current Infosys events matching filters'
                    : sourceFilter.includes('CSE')
                      ? 'No Google Search Engine (CSE) results returned'
                      : 'No active incidents matching filters'}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {sourceFilter.includes('CSE')
                  ? 'Click "Reload Live CSE Stream" to query Google Search Engine again.'
                  : 'Adjust the search query or click "Clear All" to restore the full live stream.'}
              </p>
              {sourceFilter.includes('CSE') && (
                <button
                  onClick={() => handleSourceFilterChange('Google Search Engine (CSE)')}
                  className="mt-3 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition cursor-pointer"
                >
                  Reload Live CSE Stream
                </button>
              )}
            </div>
          ) : (
            filteredArticles.map((article, idx) => {
              const isCritical = article.risk_level === 'Critical' || (article as any).severity === 'CRITICAL' || (Number(article.risk_score || (article as any).score) >= 9.0);
              const isHigh = !isCritical && (article.risk_level === 'High' || (article as any).severity === 'HIGH' || (Number(article.risk_score || (article as any).score) >= 7.0));
              const isMedium = !isCritical && !isHigh && (article.risk_level === 'Medium' || (article as any).severity === 'MEDIUM' || (Number(article.risk_score || (article as any).score) >= 4.0));
              const isAcknowledged = article.status === 'ACKNOWLEDGED';
              const isExpanded = Boolean(expandedBriefs[article.id]);

              const badge = getSourceBadge(article.source_name);
              const thumbnailSrc = getThumbnailForArticle(article, idx);

              let detectedTime = 'Just now';
              let publishedRelativeTime = 'Just now';
              try {
                detectedTime = formatDistanceToNow(
                  new Date(article.ingested_at || article.published_at),
                  { addSuffix: true }
                );
              } catch {
                detectedTime = 'Recent';
              }
              try {
                publishedRelativeTime = formatDistanceToNow(
                  new Date(article.published_at || article.ingested_at),
                  { addSuffix: true }
                );
              } catch {
                publishedRelativeTime = 'Recent';
              }

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
                      : '5.0';

              // Severity styles
              let severityBadgeClass = 'bg-slate-100 text-slate-700 border-slate-200';
              if (isCritical) {
                severityBadgeClass = 'bg-rose-50 text-rose-600 border-rose-200 font-bold';
              } else if (isHigh) {
                severityBadgeClass = 'bg-amber-50 text-amber-700 border-amber-200 font-bold';
              } else if (isMedium) {
                severityBadgeClass = 'bg-blue-50 text-blue-700 border-blue-200 font-bold';
              }

              // Extract tag words from theme or text
              const tags = [
                article.entity_mentioned || 'Infosys',
                isCritical ? 'Regulatory' : isHigh ? 'Market' : 'Enterprise',
                'Intelligence'
              ];

              return (
                <div
                  key={article.id}
                  className={`rounded-xl border transition-all duration-200 shadow-2xs hover:shadow-xs p-4 sm:p-5 ${isCritical
                    ? 'bg-rose-50/20 border-rose-200 border-l-4 border-l-rose-600'
                    : 'bg-white border-slate-200/90'
                    } ${isAcknowledged ? 'opacity-65 bg-slate-50/50' : ''}`}
                >
                  {/* Horizontal Card Layout */}
                  <div className="flex flex-col sm:flex-row gap-4 sm:gap-5 items-start">
                    {/* A. Left Column (Image Area): exactly 155px, shrink-0, hidden on mobile */}
                    <div className="hidden sm:flex w-[155px] h-[105px] shrink-0 rounded-lg overflow-hidden bg-slate-100 border border-slate-200/80">
                      <img
                        src={thumbnailSrc}
                        alt="Article thumbnail"
                        onError={(e) => {
                          (e.target as HTMLElement).setAttribute(
                            'src',
                            'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=500&auto=format&fit=crop&q=80'
                          );
                        }}
                        className="w-full h-full object-cover"
                      />
                    </div>

                    {/* B. Right Column (Content Area): flex-grows to fill remaining space */}
                    <div className="flex-1 min-w-0 space-y-2.5">
                      {/* Top Row: Source, Time, Target, and Severity Badge */}
                      <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
                        <div className="flex items-center gap-2 text-slate-500 flex-wrap">
                          {/* Breaking pill on Critical */}
                          {isCritical && (
                            <span className="px-1.5 py-0.5 rounded bg-rose-600 text-white font-mono text-[9px] font-bold tracking-wider">
                              BREAKING
                            </span>
                          )}

                          {/* Source Brand Badge */}
                          <span
                            className={`w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold ${badge.bg} ${badge.text}`}
                          >
                            {badge.tag}
                          </span>
                          <span className="font-semibold text-slate-700">
                            {article.source_name || 'News Wire'}
                          </span>

                          {/* API Source Tag + Aggregated vs Direct-Wire vs Manual Upload indicator */}
                          {(() => {
                            const src = (article.api_source || '').toLowerCase();
                            const isManualUpload = src.includes('manual_ocr_upload') || src.includes('manual') || (article as any).source_type === 'manual_ocr_upload';
                            // Bluesky Jetstream is a live WebSocket firehose — genuinely real-time
                            const isRealTimeStream = !isManualUpload && (src.includes('bluesky') || src.includes('jetstream') || src.includes('firehose'));
                            // All polling/REST aggregator sources -- upstream lag is real and outside our control
                            const isAggregator = !isManualUpload && !isRealTimeStream && (
                              src.includes('rss') ||
                              src.includes('google') ||
                              src.includes('newsdata') ||
                              src.includes('gnews') ||
                              src.includes('guardian') ||
                              src.includes('institutional') ||
                              src.includes('newsapi') ||
                              src.includes('currents') ||
                              src.includes('event registry') ||
                              src.includes('gdelt') ||
                              src.includes('epaper') ||
                              src.includes('ocr')
                            );
                            return (
                              <>
                                <span className="px-1.5 py-0.2 rounded bg-slate-100 text-slate-500 text-[9px] uppercase font-bold tracking-wider border border-slate-200">
                                  VIA {article.api_source?.toUpperCase() || 'GOOGLE RSS'}
                                </span>
                                {isManualUpload && (
                                  <span
                                    title="Manual Intel Upload — Scanned document/clipping processed via OCR and AI triage."
                                    className="px-1.5 py-0.2 rounded bg-purple-100 text-purple-800 text-[9px] uppercase font-bold tracking-wider border border-purple-300 shadow-2xs cursor-help"
                                  >
                                    MANUAL UPLOAD
                                  </span>
                                )}
                                {isRealTimeStream && (
                                  <span
                                    title="Bluesky Jetstream WebSocket firehose — genuine real-time push stream. Detection latency is typically seconds from publication."
                                    className="px-1.5 py-0.2 rounded bg-emerald-50 text-emerald-700 text-[9px] uppercase font-bold tracking-wider border border-emerald-200 cursor-help"
                                  >
                                    REAL-TIME STREAM
                                  </span>
                                )}
                                {isAggregator && (
                                  <span
                                    title="Aggregated source — publisher → aggregator → us. Upstream lag of 5–60min is normal and outside our control. Do NOT interpret detection time as publication time."
                                    className="px-1.5 py-0.2 rounded bg-amber-50 text-amber-600 text-[9px] uppercase font-bold tracking-wider border border-amber-200 cursor-help"
                                  >
                                    AGGREGATED
                                  </span>
                                )}
                                {!isManualUpload && !isRealTimeStream && !isAggregator && (
                                  <span
                                    title="Direct-wire API — lowest upstream lag for this source type."
                                    className="px-1.5 py-0.2 rounded bg-blue-50 text-blue-600 text-[9px] uppercase font-bold tracking-wider border border-blue-200 cursor-help"
                                  >
                                    DIRECT WIRE
                                  </span>
                                )}
                              </>
                            );
                          })()}

                          {/* Low OCR Quality Badge */}
                          {(article.ocr_quality === 'low' ||
                            article.isLowConfidence ||
                            ((article as any).ocrConfidence !== undefined && (article as any).ocrConfidence < 70) ||
                            ((article as any).ocr_confidence !== undefined && (article as any).ocr_confidence < 70)) && (
                              <span
                                title="OCR text extraction confidence is under 70%. Verify source text."
                                className="px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 text-[9px] uppercase font-bold tracking-wider border border-amber-300 flex items-center gap-1 cursor-help"
                              >
                                <AlertTriangle className="w-2.5 h-2.5 text-amber-600" />
                                <span>Low OCR quality: verify the source</span>
                              </span>
                            )}

                          <span className="text-slate-300">•</span>
                          <span className="flex items-center gap-1 text-emerald-700 font-medium">
                            <Clock className="w-3.5 h-3.5 text-emerald-500" />
                            Detected {detectedTime}
                          </span>
                          <span className="text-slate-300">·</span>
                          <span className="text-slate-400 text-[10px]">
                            {article.pub_date ? `Published ${article.pub_date}` : article.published_at ? `Published ${publishedRelativeTime}` : 'Publish date unknown'}
                          </span>

                          <span className="text-slate-300">•</span>
                          <span>
                            Target:{' '}
                            <strong className="text-slate-900 font-semibold">
                              {article.entity_mentioned || 'Infosys'}
                            </strong>
                          </span>
                        </div>

                        {/* Top-Right Severity Badge */}
                        <div className="flex items-center gap-2 shrink-0">
                          <span
                            className={`px-2.5 py-0.5 rounded text-xs font-mono tracking-wide border ${severityBadgeClass}`}
                          >
                            {(isCritical ? 'CRITICAL' : isHigh ? 'HIGH' : (article.risk_level?.toUpperCase() || 'MEDIUM'))} {scoreValue}/10
                          </span>

                          {isAcknowledged && (
                            <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 border border-emerald-200 text-emerald-700 font-mono">
                              ACKNOWLEDGED
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Dedicated Detection Latency Section */}
                      <div className="pt-0.5 pb-1">
                        <DetectionLatencyBadge
                          publishedAt={article.published_at}
                          detectedAt={article.ingested_at}
                          apiSource={article.api_source}
                        />
                      </div>

                      {/* Headline & Expandable Full Article Body */}
                      {(() => {
                        const headline = (article.title || '').trim();
                        // Find the longest article body available across raw_content, content, description
                        const candidates = [
                          (article.raw_content || '').trim(),
                          (article.content || '').trim(),
                          (article.description || '').trim()
                        ];
                        const fullBody = candidates.reduce((longest, curr) => curr.length > longest.length ? curr : longest, '');

                        const isExpanded = Boolean(expandedHeadlines[article.id]);
                        const charLimit = 90;
                        const isHeadlineLong = headline.length > charLimit;

                        // Truncate headline cleanly at a word boundary when collapsed
                        let collapsedHeadline = headline;
                        if (isHeadlineLong) {
                          const spaceIdx = headline.indexOf(' ', charLimit);
                          const cutPoint = spaceIdx !== -1 && spaceIdx < charLimit + 15 ? spaceIdx : charLimit;
                          collapsedHeadline = `${headline.substring(0, cutPoint)}…`;
                        }

                        // Has more content to reveal (either longer headline or full article body)
                        const hasMore = isHeadlineLong || (fullBody.length > 0 && fullBody !== headline);

                        if (!isExpanded) {
                          return (
                            <h3 className="font-bold text-[17px] text-black leading-snug break-words">
                              <span>{collapsedHeadline}</span>
                              {hasMore && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleHeadline(article.id);
                                  }}
                                  className="ml-1.5 inline-block text-xs font-semibold text-blue-600 hover:text-blue-700 transition-colors cursor-pointer select-none"
                                >
                                  [Read more]
                                </button>
                              )}
                            </h3>
                          );
                        }

                        // Expanded view: Full headline + Full article body from first word to final full stop + [Show less]
                        return (
                          <div className="space-y-2.5">
                            <h3 className="font-bold text-[17px] text-black leading-snug break-words">
                              <span>{headline}</span>
                            </h3>

                            {fullBody && (
                              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/90 text-[13px] text-slate-800 leading-relaxed whitespace-pre-wrap break-words font-normal">
                                <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                                  Full Scanned Article Intelligence:
                                </p>
                                {fullBody}
                              </div>
                            )}

                            <div>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleHeadline(article.id);
                                }}
                                className="inline-block text-xs font-semibold text-blue-600 hover:text-blue-700 transition-colors cursor-pointer select-none"
                              >
                                [Show less]
                              </button>
                            </div>
                          </div>
                        );
                      })()}

                      {/* Summary with inline [Read more] / [Show less] toggle */}
                      {(() => {
                        const summaryText = typeof article.summary === 'string' ? article.summary : '';
                        const rawText =
                          article.five_bullet_summary?.[0] ||
                          summaryText ||
                          article.content ||
                          article.raw_content ||
                          article.description ||
                          article.snippet ||
                          '';
                        const trimmed = rawText.trim();
                        const hasPrefix = trimmed.toLowerCase().startsWith('what happened:');
                        const fullText = hasPrefix ? trimmed.substring('what happened:'.length).trim() : trimmed;
                        const isExpanded = Boolean(expandedSummaries[article.id]);
                        const charLimit = 90;
                        const isLong = fullText.length > charLimit;

                        let collapsedSummary = fullText;
                        if (isLong) {
                          const spaceIdx = fullText.indexOf(' ', charLimit);
                          const cutPoint = spaceIdx !== -1 && spaceIdx < charLimit + 15 ? spaceIdx : charLimit;
                          collapsedSummary = `${fullText.substring(0, cutPoint)}…`;
                        }

                        const displayText = isLong && !isExpanded ? collapsedSummary : fullText;

                        return (
                          <div className="mt-1 text-[13px] leading-relaxed text-black dark:text-black font-normal break-words">
                            <span className="font-semibold text-black dark:text-black">What happened: </span>
                            <span>{displayText}</span>
                            {isLong && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleSummary(article.id);
                                }}
                                className="ml-1.5 inline font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors cursor-pointer select-none"
                              >
                                {isExpanded ? '[Show less]' : '[Read more]'}
                              </button>
                            )}
                          </div>
                        );
                      })()}

                      {/* Tags Bar */}
                      <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                        {tags.map((tag, idx) => (
                          <span
                            key={idx}
                            className="px-2 py-0.5 rounded text-[11px] bg-slate-100 text-slate-600 font-medium border border-slate-200/60"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>

                      {/* Extracted Document Intelligence Fields (for manual uploads / scanned docs) */}
                      {(article.api_source?.toLowerCase().includes('manual') ||
                        article.author ||
                        article.pub_date ||
                        article.page_no ||
                        article.info) && (
                        <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/90 space-y-2 text-xs">
                          <div className="text-[10px] font-mono font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                            <FileText className="w-3.5 h-3.5 text-purple-600" />
                            <span>EXTRACTED DOCUMENT INTELLIGENCE:</span>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pb-2 border-b border-slate-200/60 text-xs">
                            <div>
                              <span className="text-slate-400 font-semibold block text-[10px] uppercase">Date:</span>
                              <span className="text-slate-900 font-medium break-words">
                                {article.pub_date || (article.published_at ? new Date(article.published_at).toLocaleDateString() : 'Not found')}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-400 font-semibold block text-[10px] uppercase">Author:</span>
                              <span className="text-slate-900 font-medium break-words">
                                {article.author || 'Not found'}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-400 font-semibold block text-[10px] uppercase">Page:</span>
                              <span className="text-slate-900 font-medium break-words">
                                {article.page_no || 'Not found'}
                              </span>
                            </div>
                          </div>

                          <div className="space-y-1 pt-0.5">
                            <span className="text-slate-400 font-semibold block text-[10px] uppercase">Info:</span>
                            <p className="text-slate-900 font-normal leading-relaxed break-words whitespace-pre-wrap">
                              {article.info || 'Not found'}
                            </p>
                          </div>

                          <div className="space-y-1 pt-0.5">
                            <span className="text-slate-400 font-semibold block text-[10px] uppercase">Summary:</span>
                            <p className="text-slate-900 font-normal leading-relaxed break-words whitespace-pre-wrap">
                              {typeof article.summary === 'string'
                                ? article.summary
                                : (Array.isArray(article.summary) ? article.summary.join(' ') : 'Not found')}
                            </p>
                          </div>
                        </div>
                      )}

                      {/* Progressive Disclosure: Collapsible 5-Bullet Brief */}
                      <div>
                        <button
                          onClick={() => toggleBrief(article.id)}
                          className="flex items-center gap-1 text-xs font-semibold text-slate-700 hover:text-slate-900 transition-colors cursor-pointer py-1"
                        >
                          {isExpanded ? (
                            <>
                              <ChevronUp className="w-3.5 h-3.5 text-slate-500" />
                              <span>Hide Executive 5-Bullet Intelligence Brief</span>
                            </>
                          ) : (
                            <>
                              <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                              <span>Show Executive 5-Bullet Intelligence Brief</span>
                            </>
                          )}
                        </button>

                        {isExpanded && (
                          <div className="mt-2.5 p-3.5 rounded-lg bg-slate-50 border border-slate-200/80 space-y-2 text-xs">
                            <h4 className="font-mono font-bold uppercase tracking-wider text-slate-500 text-[10px]">
                              EXECUTIVE 5-BULLET INTELLIGENCE BRIEF:
                            </h4>
                            <ul className="space-y-2 text-slate-700 list-disc list-inside marker:text-rose-500 leading-relaxed text-xs">
                              {Array.isArray(article.five_bullet_summary) &&
                                article.five_bullet_summary.length > 0 ? (
                                article.five_bullet_summary.map((b, i) => {
                                  const bulletStr = String(b || '').trim();
                                  const colonIndex = bulletStr.indexOf(':');
                                  if (colonIndex > 0 && colonIndex < 35) {
                                    return (
                                      <li key={i} className="pl-0.5 leading-relaxed break-words">
                                        <span className="font-semibold text-slate-900">{bulletStr.substring(0, colonIndex + 1)}</span>
                                        <span>{bulletStr.substring(colonIndex + 1)}</span>
                                      </li>
                                    );
                                  }
                                  return (
                                    <li key={i} className="pl-0.5 leading-relaxed break-words">
                                      <span>{bulletStr}</span>
                                    </li>
                                  );
                                })
                              ) : (
                                <li className="leading-relaxed">Real-time event recorded into central memory store.</li>
                              )}
                            </ul>

                            {/* Authentic Article Lifecycle Timeline */}
                            <ArticleLifecycleTimeline
                              publishedAt={article.published_at}
                              detectedAt={article.ingested_at}
                              triagedAt={article.triaged_at}
                              dispatchedAt={article.dispatched_at || article.alerted_at}
                            />
                          </div>
                        )}
                      </div>

                      {/* Bottom Row Action Buttons */}
                      <div className="flex items-center justify-between pt-2 border-t border-slate-100 flex-wrap gap-2">
                        {/* View Source functional link */}
                        {(() => {
                          let effectiveUrl = article.url || (article as any).sourceUrl || '';
                          if (effectiveUrl.startsWith('at://')) {
                            const parts = effectiveUrl.replace('at://', '').split('/');
                            effectiveUrl = `https://bsky.app/profile/${parts[0]}/post/${parts[2] || ''}`;
                          }
                          // Fallback: If URL is a Bluesky image CDN URL, route to user profile on bsky.app rather than raw image
                          if (effectiveUrl.includes('cdn.bsky.app')) {
                            const didMatch = effectiveUrl.match(/did:plc:[a-z0-9]+/i);
                            if (didMatch) {
                              effectiveUrl = `https://bsky.app/profile/${didMatch[0]}`;
                            }
                          }
                          const isBluesky = effectiveUrl.includes('bsky.app');
                          const isReachable = effectiveUrl && (!unreachableUrls.has(effectiveUrl) || isBluesky);

                          if (isReachable) {
                            return (
                              <a
                                href={effectiveUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 hover:underline transition-colors cursor-pointer"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                                <span>View Source</span>
                              </a>
                            );
                          } else if (effectiveUrl && unreachableUrls.has(effectiveUrl)) {
                            return (
                              <span
                                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 bg-slate-100/90 px-2 py-1 rounded cursor-not-allowed select-none"
                                title="Source unavailable (publisher link returned 404 or dead link)"
                              >
                                <ExternalLink className="w-3.5 h-3.5 opacity-40" />
                                <span>Source unavailable</span>
                              </span>
                            );
                          }
                          return <span className="text-xs text-slate-400">Verified Wire Source</span>;
                        })()}

                        {/* Action Buttons */}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => onAcknowledge(article.id)}
                            disabled={isAcknowledged}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer ${isAcknowledged
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200 cursor-default'
                              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50 active:bg-slate-100 shadow-2xs'
                              }`}
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>{isAcknowledged ? 'Acknowledged' : 'Acknowledge'}</span>
                          </button>

                          <button
                            onClick={() => onEscalateVoice(article)}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white shadow-2xs transition-all cursor-pointer"
                          >
                            <PhoneCall className="w-3.5 h-3.5 text-rose-500" />
                            <span>Escalate Voice Call</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* ========================================================= */}
        {/* RIGHT COLUMN: Intelligence Sidebar (~25% -> col-span-3) */}
        {/* ========================================================= */}
        <div className="lg:col-span-3 space-y-4">
          {/* Card 1: Live Overview */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3">
            <div className="flex items-center gap-2 pb-1 border-b border-slate-100">
              <Activity className="w-4 h-4 text-rose-600" />
              <div>
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wide">Live Overview</h3>
                <p className="text-[10px] text-slate-400">Real-time monitoring</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                <div className="text-[11px] text-slate-500 font-medium">Total Events</div>
                <div className="text-xl font-bold text-slate-900 mt-0.5 font-mono">{totalEvents}</div>
              </div>
              <div className="p-2.5 rounded-lg bg-rose-50/60 border border-rose-100">
                <div className="text-[11px] text-rose-700 font-medium">Critical</div>
                <div className="text-xl font-bold text-rose-600 mt-0.5 font-mono">{criticalCount}</div>
              </div>
              <div className="p-2.5 rounded-lg bg-amber-50/60 border border-amber-100">
                <div className="text-[11px] text-amber-700 font-medium">High</div>
                <div className="text-xl font-bold text-amber-600 mt-0.5 font-mono">{highCount}</div>
              </div>
              <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                <div className="text-[11px] text-slate-500 font-medium">Others</div>
                <div className="text-xl font-bold text-slate-700 mt-0.5 font-mono">{othersCount}</div>
              </div>
            </div>
          </div>

          {/* Card 2: Detection Performance Split by Source Type (Push vs Polled) */}
          <div className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-2xs space-y-2.5">
            <div className="flex items-center justify-between pb-1 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-emerald-600" />
                <div>
                  <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wide">Detection Velocity</h3>
                  <p className="text-[10px] text-slate-400">Split by Ingestion Source Type</p>
                </div>
              </div>
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200 font-mono uppercase">
                PUSH VS POLLED
              </span>
            </div>

            {/* PUSH STREAM (Bluesky Jetstream WebSocket) */}
            <div className="rounded-lg bg-emerald-50/50 border border-emerald-200/80 p-2 space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  <span className="text-[10px] font-bold text-emerald-950 uppercase tracking-wide">
                    Push Stream
                  </span>
                  <span className="text-[9px] text-emerald-700 font-medium hidden sm:inline">
                    (Bluesky Jetstream)
                  </span>
                </div>
                <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800 border border-emerald-300 font-mono">
                  ≤ 2m Target
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="bg-white/90 rounded border border-emerald-200/60 px-2 py-1">
                  <div className="text-[9px] text-slate-500 font-medium">Avg Detection</div>
                  <div className="text-sm font-bold text-emerald-950 font-mono">
                    {splitLatency.push.formattedAverage}
                  </div>
                </div>
                <div className="bg-white/90 rounded border border-emerald-200/60 px-2 py-1">
                  <div className="text-[9px] text-slate-500 font-medium">P95 Detection</div>
                  <div className="text-sm font-bold text-emerald-950 font-mono">
                    {splitLatency.push.formattedP95}
                  </div>
                </div>
              </div>
              <div className="text-[8.5px] text-emerald-800/80 font-mono flex items-center justify-between px-0.5">
                <span>Direct WebSocket Firehose</span>
                <span>{splitLatency.push.count} articles</span>
              </div>
            </div>

            {/* POLLED / AGGREGATED (Google RSS, News APIs, Institutional Wires) */}
            <div className="rounded-lg bg-slate-50 border border-slate-200/80 p-2 space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-amber-500" />
                  <span className="text-[10px] font-bold text-slate-800 uppercase tracking-wide">
                    Push Stream
                  </span>
                  <span className="text-[9px] text-slate-400 font-medium hidden sm:inline">
                    (Bluesky Jetstream [RSS / APIs])
                  </span>
                </div>
                <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-amber-50 text-amber-700 border border-amber-200 font-mono">
                  ≤ 3h Target
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="bg-white rounded border border-slate-200/60 px-2 py-1">
                  <div className="text-[9px] text-slate-500 font-medium">Avg Detection</div>
                  <div className="text-sm font-bold text-slate-900 font-mono">
                    {splitLatency.polled.formattedAverage}
                  </div>
                </div>
                <div className="bg-white rounded border border-slate-200/60 px-2 py-1">
                  <div className="text-[9px] text-slate-500 font-medium">P95 Detection</div>
                  <div className="text-sm font-bold text-slate-900 font-mono">
                    {splitLatency.polled.formattedP95}
                  </div>
                </div>
              </div>
              <div className="text-[8.5px] text-slate-500 font-mono flex items-center justify-between px-0.5">
                <span>Upstream Syndication Floor</span>
                <span>{splitLatency.polled.count} articles</span>
              </div>
            </div>
          </div>

          {/* Card 2: Targets Under Watch */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3">
            <div className="flex items-center gap-2 pb-1 border-b border-slate-100">
              <ShieldAlert className="w-4 h-4 text-rose-600" />
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wide">Targets Under Watch</h3>
            </div>

            <div className="space-y-2 pt-1 text-xs">
              {[
                { name: 'Infosys', count: targetCounts.Infosys || 0, color: 'bg-blue-600' },
                { name: 'TCS', count: targetCounts.TCS || 0, color: 'bg-purple-600' },
                { name: 'Wipro', count: targetCounts.Wipro || 0, color: 'bg-emerald-600' },
                { name: 'Accenture', count: targetCounts.Accenture || 0, color: 'bg-rose-600' }
              ].map((target) => (
                <div
                  key={target.name}
                  className="flex items-center justify-between p-2 rounded-lg bg-slate-50 hover:bg-slate-100/70 transition-colors border border-slate-100"
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${target.color}`} />
                    <span className="font-semibold text-slate-800">{target.name}</span>
                  </div>
                  <span className="font-mono font-bold text-slate-700 px-2 py-0.5 rounded bg-white border border-slate-200 text-[11px]">
                    {target.count}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Card 3: Event Trends (SVG Area Wave) */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3">
            <div className="flex items-center justify-between pb-1 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-rose-600" />
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wide">Event Trends</h3>
              </div>
              <span className="text-[10px] text-slate-400 font-medium">Last 24 hours</span>
            </div>

            <div className="pt-1 space-y-2">
              <div className="h-20 w-full relative flex items-end">
                {/* Clean SVG Trend Wave */}
                <svg className="w-full h-full" viewBox="0 0 240 80" fill="none" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="roseWave" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#E11D48" stopOpacity="0.3" />
                      <stop offset="100%" stopColor="#E11D48" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M 0 65 Q 30 35, 60 50 T 120 30 T 180 45 T 240 20 L 240 80 L 0 80 Z"
                    fill="url(#roseWave)"
                  />
                  <path
                    d="M 0 65 Q 30 35, 60 50 T 120 30 T 180 45 T 240 20"
                    stroke="#E11D48"
                    strokeWidth="2"
                    fill="none"
                  />
                </svg>
              </div>

              <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                <span>12AM</span>
                <span>6AM</span>
                <span>12PM</span>
                <span>6PM</span>
                <span>NOW</span>
              </div>
            </div>
          </div>

          {/* Card 4: System Status */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3">
            <div className="flex items-center justify-between pb-1 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4 text-emerald-600" />
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wide">System Status</h3>
              </div>
              <span className="text-[10px] font-semibold text-emerald-600 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Active
              </span>
            </div>

            <div className="space-y-2 pt-1 text-xs">
              <div className="flex items-center justify-between text-slate-600">
                <span className="flex items-center gap-1.5">
                  <Radio className="w-3.5 h-3.5 text-slate-400" />
                  News Ingestion
                </span>
                <span className="text-emerald-600 font-semibold font-mono text-[11px]">Live</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span className="flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 text-slate-400" />
                  AI Analysis
                </span>
                <span className="text-emerald-600 font-semibold font-mono text-[11px]">Active</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span className="flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-slate-400" />
                  Alert Engine
                </span>
                <span className="text-emerald-600 font-semibold font-mono text-[11px]">Running</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span className="flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-slate-400" />
                  Database
                </span>
                <span className="text-emerald-600 font-semibold font-mono text-[11px]">Connected</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
