import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import {
  TrendingUp,
  Frown,
  Megaphone,
  Shield,
  FileText,
  Building2,
  Zap,
  Search,
  ChevronDown,
  RotateCcw,
  Calendar,
  ArrowRight,
  Smile,
  Meh,
  ArrowUpRight,
  ArrowDownRight,
  Activity
} from 'lucide-react';
import { useWarRoom, Article } from '../hooks/useWarRoom';

interface IntelligenceTrendAnalysisViewProps {
  articles?: Article[];
  onSelectArticle?: (art: Article) => void;
}

// Entity classifier strictly using article metadata
const getEntityForArticle = (a: Article): 'Infosys' | 'TCS' | 'Wipro' | 'Accenture' | 'Other' => {
  const text = `${a.entity_mentioned || ''} ${(a as any).entity || ''} ${a.title || ''}`.toLowerCase();
  if (text.includes('infosys')) return 'Infosys';
  if (text.includes('tcs') || text.includes('tata consultancy') || text.includes('tata')) return 'TCS';
  if (text.includes('wipro')) return 'Wipro';
  if (text.includes('accenture')) return 'Accenture';
  return 'Other';
};

export const IntelligenceTrendAnalysisView: React.FC<IntelligenceTrendAnalysisViewProps> = ({
  articles: propArticles,
  onSelectArticle
}) => {
  const navigate = useNavigate();
  const hookData = useWarRoom();
  const rawArticles = propArticles ?? hookData.articles;

  // 1. STATE MANAGEMENT (Client-side interactive filters)
  const [timeRange, setTimeRange] = useState<'24H' | '7D' | '30D' | '90D' | 'Custom'>('24H');
  const [isCustomRangeOpen, setIsCustomRangeOpen] = useState(false);
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [customRangeLabel, setCustomRangeLabel] = useState('Custom Range');
  const customRangeRef = useRef<HTMLDivElement>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [entityFilter, setEntityFilter] = useState('All');
  const [sentimentFilter, setSentimentFilter] = useState('All');
  const [sourceFilter, setSourceFilter] = useState('All');
  const [riskFilter, setRiskFilter] = useState('All');

  // Close Custom Range popover on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (customRangeRef.current && !customRangeRef.current.contains(event.target as Node)) {
        setIsCustomRangeOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Time-window filtered articles
  const timeFilteredArticles = useMemo(() => {
    if (!rawArticles || rawArticles.length === 0) return [];

    if (timeRange === 'Custom') {
      if (customStartDate || customEndDate) {
        const startMs = customStartDate ? new Date(customStartDate + 'T00:00:00').getTime() : 0;
        const endMs = customEndDate ? new Date(customEndDate + 'T23:59:59').getTime() : Date.now();

        const filtered = rawArticles.filter((a) => {
          const time = new Date(a.ingested_at || a.published_at).getTime();
          return !isNaN(time) && time >= startMs && time <= endMs;
        });
        return filtered.length > 0 ? filtered : rawArticles;
      }
      return rawArticles;
    }

    const now = Date.now();
    const windowHours =
      timeRange === '24H' ? 24 : timeRange === '7D' ? 168 : timeRange === '30D' ? 720 : 2160;

    const filtered = rawArticles.filter((a) => {
      const time = new Date(a.ingested_at || a.published_at).getTime();
      return !isNaN(time) && now - time <= windowHours * 60 * 60 * 1000;
    });

    // If dataset is historical or time filtering results in 0, fallback gracefully to raw articles
    return filtered.length > 0 ? filtered : rawArticles;
  }, [rawArticles, timeRange, customStartDate, customEndDate]);

  // Extract unique active sources
  const availableSources = useMemo(() => {
    const set = new Set<string>();
    rawArticles.forEach((a) => {
      if (a.source_name) set.add(a.source_name);
    });
    return Array.from(set).sort();
  }, [rawArticles]);

  // Main filtered articles according to secondary toolbar
  const filteredArticles = useMemo(() => {
    return timeFilteredArticles.filter((a) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matches =
          (a.title || '').toLowerCase().includes(q) ||
          (a.raw_content || '').toLowerCase().includes(q) ||
          (a.entity_mentioned || '').toLowerCase().includes(q) ||
          (a.source_name || '').toLowerCase().includes(q);
        if (!matches) return false;
      }

      if (entityFilter !== 'All') {
        if (getEntityForArticle(a) !== entityFilter) return false;
      }

      if (sentimentFilter !== 'All') {
        if (a.sentiment !== sentimentFilter) return false;
      }

      if (sourceFilter !== 'All') {
        const apiSrc = (a.api_source || '').toLowerCase();
        if (sourceFilter === 'Google News RSS') {
          if (!apiSrc.includes('google') && !apiSrc.includes('rss')) return false;
          if (apiSrc.includes('cse') || apiSrc.includes('publisher') || apiSrc.includes('et') || apiSrc.includes('institutional')) return false;
        } else if (sourceFilter === 'Google Search Engine (CSE)') {
          if (!apiSrc.includes('cse')) return false;
        } else if (sourceFilter === 'GDELT DOC') {
          if (!apiSrc.includes('gdelt')) return false;
        } else if (sourceFilter === 'Institutional') {
          if (!apiSrc.includes('institutional') && !apiSrc.includes('et') && !apiSrc.includes('publisher')) return false;
        } else if (sourceFilter === 'NewsAPI') {
          if (!apiSrc.includes('newsapi')) return false;
        } else if (sourceFilter === 'Currents API') {
          if (!apiSrc.includes('currents')) return false;
        } else if (sourceFilter === 'Bluesky Social') {
          if (!apiSrc.includes('bluesky')) return false;
        }
      }

      if (riskFilter !== 'All') {
        if (a.risk_level !== riskFilter) return false;
      }

      return true;
    });
  }, [timeFilteredArticles, searchQuery, entityFilter, sentimentFilter, sourceFilter, riskFilter]);

  const clearAllFilters = () => {
    setSearchQuery('');
    setEntityFilter('All');
    setSentimentFilter('All');
    setSourceFilter('All');
    setRiskFilter('All');
  };

  const hasActiveSecondaryFilters =
    searchQuery.trim() !== '' ||
    entityFilter !== 'All' ||
    sentimentFilter !== 'All' ||
    sourceFilter !== 'All' ||
    riskFilter !== 'All';

  // 2. MATHEMATICAL KPI DERIVATIONS (Zero Mock Data)
  const totalCount = filteredArticles.length;

  // A. Total Mentions (24h)
  const totalMentions24h = useMemo(() => {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return filteredArticles.filter((a) => {
      const t = new Date(a.ingested_at || a.published_at).getTime();
      return !isNaN(t) && t >= oneDayAgo;
    }).length;
  }, [filteredArticles]);

  // B. Infosys Share of Voice
  const infosysSoV = useMemo(() => {
    if (!filteredArticles.length) return '0.0%';
    const infCount = filteredArticles.filter((a) => {
      const ent = ((a as any).entity || a.entity_mentioned || a.title || '').toLowerCase();
      return ent.includes('infosys');
    }).length;
    return `${((infCount / filteredArticles.length) * 100).toFixed(1)}%`;
  }, [filteredArticles]);

  const infosysCount = useMemo(
    () =>
      filteredArticles.filter((a) => {
        const ent = ((a as any).entity || a.entity_mentioned || a.title || '').toLowerCase();
        return ent.includes('infosys');
      }).length,
    [filteredArticles]
  );

  // C. Average Risk Score
  const avgRiskScore = useMemo(() => {
    if (!filteredArticles.length) return '0.0';
    const sum = filteredArticles.reduce((acc, curr) => acc + (Number(curr.risk_score) || 0), 0);
    return (sum / filteredArticles.length).toFixed(1);
  }, [filteredArticles]);

  // D. Negative Sentiment Ratio / Threat Rate (Percentage of items categorized as Critical or High risk)
  const highRiskCount = useMemo(
    () => filteredArticles.filter((a) => a.risk_level === 'Critical' || a.risk_level === 'High').length,
    [filteredArticles]
  );

  const negativeRatio = useMemo(() => {
    if (!filteredArticles.length) return '0.0%';
    return `${((highRiskCount / filteredArticles.length) * 100).toFixed(1)}%`;
  }, [filteredArticles, highRiskCount]);

  // Company Mention Counts
  const companyCounts = useMemo(() => {
    let infosys = 0,
      tcs = 0,
      wipro = 0,
      accenture = 0;
    filteredArticles.forEach((a) => {
      const ent = getEntityForArticle(a);
      if (ent === 'Infosys') infosys++;
      else if (ent === 'TCS') tcs++;
      else if (ent === 'Wipro') wipro++;
      else if (ent === 'Accenture') accenture++;
    });
    return { infosys, tcs, wipro, accenture };
  }, [filteredArticles]);

  const trackedCompaniesTotal =
    companyCounts.infosys + companyCounts.tcs + companyCounts.wipro + companyCounts.accenture || totalCount || 1;

  // Donut chart calculations
  const donutData = useMemo(() => {
    const infosysPct = (companyCounts.infosys / trackedCompaniesTotal) * 100;
    const tcsPct = (companyCounts.tcs / trackedCompaniesTotal) * 100;
    const wiproPct = (companyCounts.wipro / trackedCompaniesTotal) * 100;
    const accenturePct = (companyCounts.accenture / trackedCompaniesTotal) * 100;

    const circumference = 2 * Math.PI * 38; // ~238.76

    const infosysDash = (infosysPct / 100) * circumference;
    const tcsDash = (tcsPct / 100) * circumference;
    const wiproDash = (wiproPct / 100) * circumference;
    const accentureDash = (accenturePct / 100) * circumference;

    return {
      circumference,
      infosys: { pct: infosysPct.toFixed(1), dash: `${infosysDash} ${circumference}`, offset: 0 },
      tcs: { pct: tcsPct.toFixed(1), dash: `${tcsDash} ${circumference}`, offset: -infosysDash },
      wipro: {
        pct: wiproPct.toFixed(1),
        dash: `${wiproDash} ${circumference}`,
        offset: -(infosysDash + tcsDash)
      },
      accenture: {
        pct: accenturePct.toFixed(1),
        dash: `${accentureDash} ${circumference}`,
        offset: -(infosysDash + tcsDash + wiproDash)
      }
    };
  }, [companyCounts, trackedCompaniesTotal]);

  // 3. TIME-SERIES DERIVATION FOR CHARTS (6 intervals: 12AM, 4AM, 8AM, 12PM, 4PM, 8PM)
  const { timeSeriesBuckets, hasSufficientTimeSeries } = useMemo(() => {
    const buckets = [
      { label: '12AM', startH: 0, endH: 4, pos: 0, neu: 0, neg: 0, total: 0, riskSum: 0 },
      { label: '4AM', startH: 4, endH: 8, pos: 0, neu: 0, neg: 0, total: 0, riskSum: 0 },
      { label: '8AM', startH: 8, endH: 12, pos: 0, neu: 0, neg: 0, total: 0, riskSum: 0 },
      { label: '12PM', startH: 12, endH: 16, pos: 0, neu: 0, neg: 0, total: 0, riskSum: 0 },
      { label: '4PM', startH: 16, endH: 20, pos: 0, neu: 0, neg: 0, total: 0, riskSum: 0 },
      { label: '8PM', startH: 20, endH: 24, pos: 0, neu: 0, neg: 0, total: 0, riskSum: 0 }
    ];

    filteredArticles.forEach((a) => {
      const d = new Date(a.ingested_at || a.published_at);
      if (!isNaN(d.getTime())) {
        const hours = d.getHours();
        const bIdx = Math.min(5, Math.floor(hours / 4));
        const b = buckets[bIdx];
        b.total++;
        if (a.sentiment === 'Positive') b.pos++;
        else if (a.sentiment === 'Negative') b.neg++;
        else b.neu++;

        const rScore = a.risk_score ? (a.risk_score > 10 ? a.risk_score / 10 : a.risk_score) : 0;
        b.riskSum += rScore;
      }
    });

    const populatedBucketsCount = buckets.filter((b) => b.total > 0).length;
    // Strictly require real data across at least 2 distinct buckets, otherwise fall back to clean enterprise state
    const hasSufficient = populatedBucketsCount >= 2;

    const mapped = buckets.map((b) => ({
      label: b.label,
      posPct: b.total > 0 ? (b.pos / b.total) * 100 : 0,
      neuPct: b.total > 0 ? (b.neu / b.total) * 100 : 0,
      negPct: b.total > 0 ? (b.neg / b.total) * 100 : 0,
      risk: b.total > 0 ? b.riskSum / b.total : 0,
      hasData: b.total > 0
    }));

    return { timeSeriesBuckets: mapped, hasSufficientTimeSeries: hasSufficient };
  }, [filteredArticles]);

  // Generate SVG path coordinates for Sentiment Trend (Width 400, Height 140)
  const sentimentSvgPaths = useMemo(() => {
    const w = 380;
    const h = 130;
    const padL = 35;
    const padR = 15;
    const padT = 15;
    const padB = 25;
    const chartW = w - padL - padR;
    const chartH = h - padT - padB;

    const getX = (idx: number) => padL + (idx / 5) * chartW;
    const getY = (pct: number) => padT + chartH - (Math.min(100, Math.max(0, pct)) / 100) * chartH;

    const buildPath = (key: 'posPct' | 'neuPct' | 'negPct') => {
      const points = timeSeriesBuckets.map((b, i) => ({ x: getX(i), y: getY(b[key]) }));
      return points.reduce((acc, p, i) => {
        if (i === 0) return `M ${p.x} ${p.y}`;
        const prev = points[i - 1];
        const cx1 = prev.x + (p.x - prev.x) / 2;
        const cy1 = prev.y;
        const cx2 = prev.x + (p.x - prev.x) / 2;
        const cy2 = p.y;
        return `${acc} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${p.x} ${p.y}`;
      }, '');
    };

    return {
      pos: buildPath('posPct'),
      neu: buildPath('neuPct'),
      neg: buildPath('negPct')
    };
  }, [timeSeriesBuckets]);

  // Generate SVG path for Risk Score Trend (Area Chart)
  const riskSvgPath = useMemo(() => {
    const w = 380;
    const h = 130;
    const padL = 30;
    const padR = 15;
    const padT = 15;
    const padB = 25;
    const chartW = w - padL - padR;
    const chartH = h - padT - padB;

    const getX = (idx: number) => padL + (idx / 5) * chartW;
    const getY = (score: number) => padT + chartH - (Math.min(10, Math.max(0, score)) / 10) * chartH;

    const points = timeSeriesBuckets.map((b, i) => ({ x: getX(i), y: getY(b.risk) }));
    const linePath = points.reduce((acc, p, i) => {
      if (i === 0) return `M ${p.x} ${p.y}`;
      const prev = points[i - 1];
      const cx1 = prev.x + (p.x - prev.x) / 2;
      const cy1 = prev.y;
      const cx2 = prev.x + (p.x - prev.x) / 2;
      const cy2 = p.y;
      return `${acc} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${p.x} ${p.y}`;
    }, '');

    const areaPath = `${linePath} L ${points[points.length - 1].x} ${padT + chartH} L ${points[0].x} ${padT + chartH} Z`;

    return { line: linePath, area: areaPath, baselineY: getY(Number(avgRiskScore) || 0) };
  }, [timeSeriesBuckets, avgRiskScore]);

  // 4. LOWER GRID: COMPANY SENTIMENT BREAKDOWN (Grouped Bar Chart)
  const companySentimentData = useMemo(() => {
    const companies: {
      name: 'Infosys' | 'TCS' | 'Wipro' | 'Accenture';
      pos: number;
      neu: number;
      neg: number;
    }[] = [
      { name: 'Infosys', pos: 0, neu: 0, neg: 0 },
      { name: 'TCS', pos: 0, neu: 0, neg: 0 },
      { name: 'Wipro', pos: 0, neu: 0, neg: 0 },
      { name: 'Accenture', pos: 0, neu: 0, neg: 0 }
    ];

    filteredArticles.forEach((a) => {
      const ent = getEntityForArticle(a);
      const match = companies.find((c) => c.name === ent);
      if (match) {
        if (a.sentiment === 'Positive') match.pos++;
        else if (a.sentiment === 'Negative') match.neg++;
        else match.neu++;
      }
    });

    const maxVal = Math.max(
      1,
      ...companies.map((c) => Math.max(c.pos, c.neu, c.neg))
    );

    return { companies, maxVal };
  }, [filteredArticles]);

  // 5. LOWER GRID: TOP COMPANIES TABLE DATA
  const topCompaniesTable = useMemo(() => {
    const list = [
      { name: 'Infosys', count: companyCounts.infosys, share: donutData.infosys.pct },
      { name: 'TCS', count: companyCounts.tcs, share: donutData.tcs.pct },
      { name: 'Wipro', count: companyCounts.wipro, share: donutData.wipro.pct },
      { name: 'Accenture', count: companyCounts.accenture, share: donutData.accenture.pct }
    ].sort((a, b) => b.count - a.count);

    return list.map((item, idx) => {
      // Determine dominant sentiment for badge
      const compArts = filteredArticles.filter((a) => getEntityForArticle(a) === item.name);
      const pos = compArts.filter((a) => a.sentiment === 'Positive').length;
      const neg = compArts.filter((a) => a.sentiment === 'Negative').length;
      const neu = compArts.filter((a) => a.sentiment === 'Neutral').length;

      let sentimentType: 'positive' | 'neutral' | 'negative' = 'neutral';
      if (pos >= neg && pos >= neu) sentimentType = 'positive';
      else if (neg > pos && neg >= neu) sentimentType = 'negative';

      const isPositiveTrend = pos >= neg;

      return {
        id: idx + 1,
        name: item.name,
        mentions: item.count,
        share: item.share,
        isPositiveTrend,
        sentimentType
      };
    });
  }, [companyCounts, donutData, filteredArticles]);

  // 6. LOWER GRID: LATEST SIGNALS (Recent 5 articles)
  const latestSignals = useMemo(() => {
    return [...filteredArticles]
      .sort((a, b) => {
        const tA = new Date(a.ingested_at || a.published_at).getTime();
        const tB = new Date(b.ingested_at || b.published_at).getTime();
        return tB - tA;
      })
      .slice(0, 5);
  }, [filteredArticles]);

  return (
    <div className="space-y-6 max-w-[1600px] mx-auto pb-14 text-slate-900 font-sans">
      {/* ========================================================= */}
      {/* 1. PAGE HEADER & TIME RANGE CONTROLS */}
      {/* ========================================================= */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-rose-50 border border-rose-200 flex items-center justify-center text-rose-600">
              <TrendingUp className="w-4 h-4" />
            </div>
            Intelligence Trend Analysis
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            Multi-variant sentiment and exposure analysis across 24h cycle.
          </p>
        </div>

        {/* Right Time Range Pills & Interactive Dropdown */}
        <div className="flex items-center gap-2">
          <div className="bg-white border border-slate-200 rounded-xl p-1 shadow-2xs flex items-center gap-1 text-xs">
            {(['24H', '7D', '30D', '90D'] as const).map((range) => (
              <button
                key={range}
                onClick={() => {
                  setTimeRange(range);
                  setIsCustomRangeOpen(false);
                }}
                className={`px-3 py-1 rounded-lg font-bold font-mono transition-all cursor-pointer ${
                  timeRange === range
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                {range}
              </button>
            ))}
          </div>

          <div ref={customRangeRef} className="relative">
            <button
              onClick={() => setIsCustomRangeOpen((prev) => !prev)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold shadow-2xs transition-all cursor-pointer ${
                timeRange === 'Custom' || isCustomRangeOpen
                  ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Calendar className={`w-3.5 h-3.5 ${timeRange === 'Custom' || isCustomRangeOpen ? 'text-white' : 'text-slate-400'}`} />
              <span>{timeRange === 'Custom' ? customRangeLabel : 'Custom Range'}</span>
              <ChevronDown
                className={`w-3 h-3 transition-transform duration-200 ${
                  isCustomRangeOpen ? 'rotate-180 text-white' : timeRange === 'Custom' ? 'text-white' : 'text-slate-400'
                } ml-0.5`}
              />
            </button>

            {/* Custom Range Popover Dropdown */}
            {isCustomRangeOpen && (
              <div className="absolute right-0 top-full mt-2 w-72 bg-white rounded-2xl border border-slate-200 shadow-xl p-4 z-50 space-y-3.5 animate-in fade-in zoom-in-95 duration-150">
                <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                  <span className="text-xs font-bold text-slate-900 font-mono uppercase tracking-wider">
                    Select Date Range
                  </span>
                  <button
                    onClick={() => setIsCustomRangeOpen(false)}
                    className="text-slate-400 hover:text-slate-600 text-xs cursor-pointer p-1"
                  >
                    ✕
                  </button>
                </div>

                {/* Quick Presets */}
                <div className="space-y-1">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Quick Presets
                  </span>
                  <div className="grid grid-cols-2 gap-1.5 pt-1">
                    <button
                      onClick={() => {
                        setTimeRange('24H');
                        setIsCustomRangeOpen(false);
                      }}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-left bg-slate-50 hover:bg-slate-100 text-slate-700 transition-colors cursor-pointer"
                    >
                      Last 24 Hours
                    </button>
                    <button
                      onClick={() => {
                        const d = new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0];
                        const today = new Date().toISOString().split('T')[0];
                        setCustomStartDate(d);
                        setCustomEndDate(today);
                        setTimeRange('Custom');
                        setCustomRangeLabel('Past 3 Days');
                        setIsCustomRangeOpen(false);
                      }}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-left bg-slate-50 hover:bg-slate-100 text-slate-700 transition-colors cursor-pointer"
                    >
                      Past 3 Days
                    </button>
                    <button
                      onClick={() => {
                        setTimeRange('7D');
                        setIsCustomRangeOpen(false);
                      }}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-left bg-slate-50 hover:bg-slate-100 text-slate-700 transition-colors cursor-pointer"
                    >
                      Past 7 Days
                    </button>
                    <button
                      onClick={() => {
                        setTimeRange('30D');
                        setIsCustomRangeOpen(false);
                      }}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-left bg-slate-50 hover:bg-slate-100 text-slate-700 transition-colors cursor-pointer"
                    >
                      Past 30 Days
                    </button>
                  </div>
                </div>

                {/* Explicit Date Inputs */}
                <div className="space-y-2 pt-1 border-t border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Custom Boundaries
                  </span>
                  <div className="space-y-2 text-xs">
                    <div>
                      <label className="text-[11px] text-slate-500 font-medium block mb-1">Start Date</label>
                      <input
                        type="date"
                        value={customStartDate}
                        onChange={(e) => setCustomStartDate(e.target.value)}
                        className="w-full px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-slate-800 text-xs focus:outline-none focus:ring-1 focus:ring-slate-900 cursor-pointer"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-slate-500 font-medium block mb-1">End Date</label>
                      <input
                        type="date"
                        value={customEndDate}
                        onChange={(e) => setCustomEndDate(e.target.value)}
                        className="w-full px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-slate-800 text-xs focus:outline-none focus:ring-1 focus:ring-slate-900 cursor-pointer"
                      />
                    </div>
                  </div>
                </div>

                {/* Popover Action Buttons */}
                <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                  <button
                    onClick={() => {
                      setCustomStartDate('');
                      setCustomEndDate('');
                      setTimeRange('24H');
                      setCustomRangeLabel('Custom Range');
                      setIsCustomRangeOpen(false);
                    }}
                    className="text-xs text-slate-500 hover:text-slate-800 font-medium cursor-pointer"
                  >
                    Reset
                  </button>
                  <button
                    onClick={() => {
                      if (customStartDate || customEndDate) {
                        setTimeRange('Custom');
                        const startLabel = customStartDate ? customStartDate.slice(5) : 'Start';
                        const endLabel = customEndDate ? customEndDate.slice(5) : 'Now';
                        setCustomRangeLabel(`${startLabel} - ${endLabel}`);
                      }
                      setIsCustomRangeOpen(false);
                    }}
                    className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold shadow-xs hover:bg-slate-800 transition-colors cursor-pointer"
                  >
                    Apply Range
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ========================================================= */}
      {/* 2. KPI ROW (FOUR COMPACT CARDS) */}
      {/* ========================================================= */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* KPI 1: Negative Sentiment Ratio */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-rose-50 border border-rose-100 flex items-center justify-center text-rose-500 shrink-0">
            <Frown className="w-6 h-6" />
          </div>
          <div>
            <span className="text-xs text-slate-500 font-medium block">Negative Sentiment Ratio</span>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-2xl font-black text-rose-600 font-mono tracking-tight">
                {negativeRatio}
              </span>
            </div>
            <span className="text-[11px] text-slate-400 block mt-0.5">
              {highRiskCount} Critical / High threat signals
            </span>
          </div>
        </div>

        {/* KPI 2: Infosys Share of Voice */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-500 shrink-0">
            <Megaphone className="w-6 h-6" />
          </div>
          <div>
            <span className="text-xs text-slate-500 font-medium block">Infosys Share of Voice</span>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-2xl font-black text-slate-900 font-mono tracking-tight">
                {infosysSoV}
              </span>
            </div>
            <span className="text-[11px] text-emerald-600 font-medium block mt-0.5">
              {infosysCount} of {totalCount} tracked events
            </span>
          </div>
        </div>

        {/* KPI 3: Average Risk Score */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center text-amber-500 shrink-0">
            <Shield className="w-6 h-6" />
          </div>
          <div>
            <span className="text-xs text-slate-500 font-medium block">Average Risk Score</span>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-2xl font-black text-amber-600 font-mono tracking-tight">
                {avgRiskScore} <span className="text-base text-slate-400 font-semibold">/ 10</span>
              </span>
            </div>
            <span className="text-[11px] text-slate-400 block mt-0.5">
              {Number(avgRiskScore) >= 7
                ? 'High risk environment'
                : Number(avgRiskScore) >= 4
                ? 'Moderate threat baseline'
                : 'Low risk baseline'}
            </span>
          </div>
        </div>

        {/* KPI 4: Total Mentions (24h) */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-500 shrink-0">
            <FileText className="w-6 h-6" />
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-xs text-slate-500 font-medium block truncate">
              Total Mentions {timeRange === '24H' ? '(24h)' : `(${timeRange})`}
            </span>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-2xl font-black text-slate-900 font-mono tracking-tight">
                {totalMentions24h.toLocaleString()}
              </span>
            </div>
            <span className="text-[11px] text-slate-400 block mt-0.5">Across all tracked sources</span>
          </div>
        </div>
      </div>

      {/* ========================================================= */}
      {/* 3. UPPER ANALYTICS GRID (THREE EQUAL COLUMNS) */}
      {/* ========================================================= */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* CARD 1: Sentiment Trend (24h) */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">Sentiment Trend (24h)</h3>
            <div className="flex items-center gap-3 text-xs font-medium">
              <span className="flex items-center gap-1.5 text-slate-600">
                <span className="w-2 h-2 rounded-full bg-emerald-500" /> Positive
              </span>
              <span className="flex items-center gap-1.5 text-slate-600">
                <span className="w-2 h-2 rounded-full bg-blue-500" /> Neutral
              </span>
              <span className="flex items-center gap-1.5 text-slate-600">
                <span className="w-2 h-2 rounded-full bg-rose-500" /> Negative
              </span>
            </div>
          </div>

          {/* SVG Multi-Line Chart or Clean Fallback */}
          {!hasSufficientTimeSeries ? (
            <div className="h-44 flex flex-col items-center justify-center p-6 text-center bg-slate-50/70 rounded-xl border border-slate-100 space-y-2">
              <div className="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
                <Activity className="w-5 h-5 animate-pulse" />
              </div>
              <div className="space-y-0.5">
                <p className="text-xs font-bold text-slate-800">
                  Real-time stream active
                </p>
                <p className="text-[11px] text-slate-500 max-w-xs">
                  Historical trend aggregation building as 24h telemetry intervals elapse.
                </p>
              </div>
            </div>
          ) : (
            <div className="w-full h-44 relative">
              <svg viewBox="0 0 380 130" className="w-full h-full overflow-visible">
                {/* Horizontal Gridlines */}
                {[0, 25, 50, 75, 100].map((level) => {
                  const y = 15 + (1 - level / 100) * 90;
                  return (
                    <g key={level}>
                      <line x1="35" y1={y} x2="365" y2={y} stroke="#F1F5F9" strokeWidth="1" />
                      <text x="28" y={y + 3} textAnchor="end" fontSize="9" fill="#94A3B8" fontFamily="monospace">
                        {level}%
                      </text>
                    </g>
                  );
                })}

                {/* Data Lines */}
                <path d={sentimentSvgPaths.neu} fill="none" stroke="#0284C7" strokeWidth="2.5" strokeLinecap="round" />
                <path d={sentimentSvgPaths.pos} fill="none" stroke="#10B981" strokeWidth="2.5" strokeLinecap="round" />
                <path d={sentimentSvgPaths.neg} fill="none" stroke="#F43F5E" strokeWidth="2.5" strokeLinecap="round" />

                {/* X-Axis Ticks */}
                {timeSeriesBuckets.map((b, idx) => {
                  const x = 35 + (idx / 5) * (365 - 35);
                  return (
                    <text key={b.label} x={x} y="125" textAnchor="middle" fontSize="9" fill="#94A3B8" fontFamily="monospace">
                      {b.label}
                    </text>
                  );
                })}
              </svg>
            </div>
          )}
        </div>

        {/* CARD 2: Share of Voice Comparison (Donut Chart) */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs flex flex-col justify-between space-y-3">
          <h3 className="text-sm font-bold text-slate-900 tracking-tight">Share of Voice Comparison</h3>

          <div className="flex items-center justify-between gap-4 py-1">
            {/* SVG Donut */}
            <div className="relative w-36 h-36 shrink-0 mx-auto sm:mx-0">
              <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                <circle cx="50" cy="50" r="38" fill="transparent" stroke="#F1F5F9" strokeWidth="13" />
                <circle
                  cx="50"
                  cy="50"
                  r="38"
                  fill="transparent"
                  stroke="#0284C7"
                  strokeWidth="13"
                  strokeDasharray={donutData.infosys.dash}
                  strokeDashoffset={donutData.infosys.offset}
                  className="transition-all duration-500"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="38"
                  fill="transparent"
                  stroke="#9333EA"
                  strokeWidth="13"
                  strokeDasharray={donutData.tcs.dash}
                  strokeDashoffset={donutData.tcs.offset}
                  className="transition-all duration-500"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="38"
                  fill="transparent"
                  stroke="#F59E0B"
                  strokeWidth="13"
                  strokeDasharray={donutData.wipro.dash}
                  strokeDashoffset={donutData.wipro.offset}
                  className="transition-all duration-500"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="38"
                  fill="transparent"
                  stroke="#10B981"
                  strokeWidth="13"
                  strokeDasharray={donutData.accenture.dash}
                  strokeDashoffset={donutData.accenture.offset}
                  className="transition-all duration-500"
                />
              </svg>
              {/* Donut Center */}
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center">
                <span className="text-xl font-black text-slate-900 font-mono leading-none">
                  {totalCount.toLocaleString()}
                </span>
                <span className="text-[9px] uppercase font-bold text-slate-400 tracking-wider mt-0.5">
                  Total Mentions
                </span>
              </div>
            </div>

            {/* Legend */}
            <div className="flex-1 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#0284C7]" />
                  <span className="font-semibold text-slate-800">Infosys</span>
                </div>
                <span className="font-mono text-slate-600 font-bold">{donutData.infosys.pct}%</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#9333EA]" />
                  <span className="font-semibold text-slate-800">TCS</span>
                </div>
                <span className="font-mono text-slate-600 font-bold">{donutData.tcs.pct}%</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#F59E0B]" />
                  <span className="font-semibold text-slate-800">Wipro</span>
                </div>
                <span className="font-mono text-slate-600 font-bold">{donutData.wipro.pct}%</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#10B981]" />
                  <span className="font-semibold text-slate-800">Accenture</span>
                </div>
                <span className="font-mono text-slate-600 font-bold">{donutData.accenture.pct}%</span>
              </div>
            </div>
          </div>
        </div>

        {/* CARD 3: Risk Score Trend (Area Chart) */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs flex flex-col justify-between space-y-3 relative">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">Risk Score Trend</h3>
            <span className="text-[11px] font-mono font-bold text-slate-700 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-md">
              Current <strong className="text-rose-600 ml-1">{avgRiskScore}</strong>
            </span>
          </div>

          {/* SVG Area Chart or Clean Fallback */}
          {!hasSufficientTimeSeries ? (
            <div className="h-44 flex flex-col items-center justify-center p-6 text-center bg-slate-50/70 rounded-xl border border-slate-100 space-y-2">
              <div className="w-9 h-9 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center">
                <Shield className="w-5 h-5" />
              </div>
              <div className="space-y-0.5">
                <p className="text-xs font-bold text-slate-800">
                  Current Threat Index: {avgRiskScore} / 10
                </p>
                <p className="text-[11px] text-slate-500 max-w-xs">
                  Continuous risk telemetry active. Multi-interval curve building.
                </p>
              </div>
            </div>
          ) : (
            <div className="w-full h-44 relative">
              <svg viewBox="0 0 380 130" className="w-full h-full overflow-visible">
                <defs>
                  <linearGradient id="riskAreaGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#F43F5E" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="#F43F5E" stopOpacity="0.0" />
                  </linearGradient>
                </defs>

                {/* Horizontal Gridlines & Y-Axis (0, 2, 4, 6, 8, 10) */}
                {[0, 2, 4, 6, 8, 10].map((score) => {
                  const y = 15 + (1 - score / 10) * 90;
                  return (
                    <g key={score}>
                      <line x1="30" y1={y} x2="365" y2={y} stroke="#F1F5F9" strokeWidth="1" />
                      <text x="24" y={y + 3} textAnchor="end" fontSize="9" fill="#94A3B8" fontFamily="monospace">
                        {score}
                      </text>
                    </g>
                  );
                })}

                {/* Dashed Baseline at 4.0 */}
                <line
                  x1="30"
                  y1={riskSvgPath.baselineY}
                  x2="365"
                  y2={riskSvgPath.baselineY}
                  stroke="#CBD5E1"
                  strokeWidth="1.5"
                  strokeDasharray="4 4"
                />

                {/* Area Fill & Main Curve */}
                <path d={riskSvgPath.area} fill="url(#riskAreaGrad)" />
                <path d={riskSvgPath.line} fill="none" stroke="#F43F5E" strokeWidth="2.5" strokeLinecap="round" />

                {/* X-Axis Ticks */}
                {timeSeriesBuckets.map((b, idx) => {
                  const x = 30 + (idx / 5) * (365 - 30);
                  return (
                    <text key={b.label} x={x} y="125" textAnchor="middle" fontSize="9" fill="#94A3B8" fontFamily="monospace">
                      {b.label}
                    </text>
                  );
                })}
              </svg>
            </div>
          )}
        </div>
      </div>

      {/* ========================================================= */}
      {/* 4. COMPACT FILTER TOOLBAR */}
      {/* ========================================================= */}
      <div className="bg-white border border-slate-200 rounded-2xl p-3 shadow-2xs flex flex-wrap items-center justify-between gap-3">
        {/* Search Input */}
        <div className="relative flex-1 min-w-[240px] max-w-sm">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search companies, sources..."
            className="w-full pl-9 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-rose-500 focus:bg-white transition-all font-sans"
          />
        </div>

        {/* Dropdowns */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Entity Dropdown */}
          <div className="relative">
            <select
              value={entityFilter}
              onChange={(e) => setEntityFilter(e.target.value)}
              aria-label="Filter by Entity"
              className="appearance-none bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 pr-7 text-xs font-semibold text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer focus:outline-none"
            >
              <option value="All">Entity: All</option>
              <option value="Infosys">Infosys</option>
              <option value="TCS">TCS</option>
              <option value="Wipro">Wipro</option>
              <option value="Accenture">Accenture</option>
            </select>
            <ChevronDown className="w-3 h-3 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>

          {/* Sentiment Dropdown */}
          <div className="relative">
            <select
              value={sentimentFilter}
              onChange={(e) => setSentimentFilter(e.target.value)}
              aria-label="Filter by Sentiment"
              className="appearance-none bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 pr-7 text-xs font-semibold text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer focus:outline-none"
            >
              <option value="All">Sentiment: All</option>
              <option value="Positive">Positive</option>
              <option value="Neutral">Neutral</option>
              <option value="Negative">Negative</option>
            </select>
            <ChevronDown className="w-3 h-3 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>

          {/* Source Dropdown */}
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="bg-slate-50 border border-slate-200 text-slate-700 text-sm rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-rose-500 transition-all"
          >
            <option value="All">Source: All</option>
            <option value="Google News RSS">Google News RSS (Verified Wire)</option>
            <option value="Google Search Engine (CSE)">Google Search Engine (CSE)</option>
            <option value="Institutional">Institutional Publisher Wires (ET, Mint, BS)</option>
            <option value="NewsAPI">NewsAPI (Global Aggregator)</option>
            <option value="Currents API">Currents Global News</option>
            <option value="Bluesky Social">Bluesky Social Wire (Trial)</option>
            <option value="GDELT DOC">GDELT DOC 2.0 (Standby)</option>
          </select>

          {/* Risk Level Dropdown */}
          <div className="relative">
            <select
              value={riskFilter}
              onChange={(e) => setRiskFilter(e.target.value)}
              aria-label="Filter by Risk Level"
              className="appearance-none bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 pr-7 text-xs font-semibold text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer focus:outline-none"
            >
              <option value="All">Risk Level: All</option>
              <option value="Critical">Critical</option>
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Low">Low</option>
            </select>
            <ChevronDown className="w-3 h-3 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>

          {/* Clear Filters Action Button */}
          {hasActiveSecondaryFilters && (
            <button
              onClick={clearAllFilters}
              className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold text-rose-600 hover:bg-rose-50 border border-rose-200 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Clear Filters</span>
            </button>
          )}
        </div>
      </div>

      {/* ========================================================= */}
      {/* 5. LOWER ANALYTICS GRID (THREE EQUAL COLUMNS) */}
      {/* ========================================================= */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* COLUMN 1: Top Companies Table */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs flex flex-col justify-between space-y-4">
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-blue-600" />
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">Top Companies</h3>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="border-b border-slate-100 text-slate-400 font-mono text-[11px]">
                  <th className="pb-2 font-semibold">#</th>
                  <th className="pb-2 font-semibold">Company</th>
                  <th className="pb-2 font-semibold">Mentions</th>
                  <th className="pb-2 font-semibold text-center">Sentiment</th>
                  <th className="pb-2 font-semibold text-right">Trend</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {topCompaniesTable.map((row) => (
                  <tr key={row.name} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-2.5 font-mono text-slate-400 font-bold">{row.id}</td>
                    <td className="py-2.5 font-semibold text-slate-900">{row.name}</td>
                    <td className="py-2.5 font-mono text-slate-700 font-bold">
                      {row.mentions}{' '}
                      <span className="text-[10px] text-slate-400 font-normal">
                        ({row.share}%)
                      </span>
                    </td>
                    <td className="py-2.5 text-center">
                      <div className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-50 border border-slate-200">
                        {row.sentimentType === 'positive' ? (
                          <Smile className="w-4 h-4 text-emerald-500" />
                        ) : row.sentimentType === 'negative' ? (
                          <Frown className="w-4 h-4 text-rose-500" />
                        ) : (
                          <Meh className="w-4 h-4 text-blue-500" />
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 text-right">
                      {row.isPositiveTrend ? (
                        <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-emerald-600 font-mono">
                          ↑ Stable
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-rose-600 font-mono">
                          ↓ Alert
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* COLUMN 2: Company Sentiment Breakdown (Grouped Bar Chart) */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900 tracking-tight">
              Company Sentiment Breakdown
            </h3>
            <div className="flex items-center gap-2 text-[11px] font-medium">
              <span className="flex items-center gap-1 text-slate-600">
                <span className="w-2 h-2 rounded-xs bg-emerald-500" /> Positive
              </span>
              <span className="flex items-center gap-1 text-slate-600">
                <span className="w-2 h-2 rounded-xs bg-blue-500" /> Neutral
              </span>
              <span className="flex items-center gap-1 text-slate-600">
                <span className="w-2 h-2 rounded-xs bg-rose-500" /> Negative
              </span>
            </div>
          </div>

          {/* Grouped Bar Chart Visual */}
          <div className="h-44 w-full flex items-end justify-between gap-4 pt-4 pb-2 border-b border-slate-100">
            {companySentimentData.companies.map((c) => {
              const maxScale = Math.max(companySentimentData.maxVal, 10);
              const posH = Math.max(8, (c.pos / maxScale) * 100);
              const neuH = Math.max(8, (c.neu / maxScale) * 100);
              const negH = Math.max(8, (c.neg / maxScale) * 100);

              return (
                <div key={c.name} className="flex-1 flex flex-col items-center h-full justify-end group">
                  {/* Bars Cluster */}
                  <div className="flex items-end gap-1 w-full justify-center h-full pb-1">
                    {/* Positive Bar */}
                    <div
                      style={{ height: `${posH}%` }}
                      title={`${c.name} Positive: ${c.pos}`}
                      className="w-3 sm:w-3.5 bg-emerald-500 rounded-t-sm transition-all duration-300 hover:brightness-110"
                    />
                    {/* Neutral Bar */}
                    <div
                      style={{ height: `${neuH}%` }}
                      title={`${c.name} Neutral: ${c.neu}`}
                      className="w-3 sm:w-3.5 bg-blue-500 rounded-t-sm transition-all duration-300 hover:brightness-110"
                    />
                    {/* Negative Bar */}
                    <div
                      style={{ height: `${negH}%` }}
                      title={`${c.name} Negative: ${c.neg}`}
                      className="w-3 sm:w-3.5 bg-rose-500 rounded-t-sm transition-all duration-300 hover:brightness-110"
                    />
                  </div>
                  {/* Company Label */}
                  <span className="text-[11px] font-semibold text-slate-600 mt-1 truncate">
                    {c.name}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* COLUMN 3: Latest Signals (Activity Feed) */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-500" />
              <h3 className="text-sm font-bold text-slate-900 tracking-tight">Latest Signals</h3>
            </div>
            <button
              onClick={() => navigate('/crisis-war-room')}
              className="text-xs font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1 cursor-pointer transition-colors"
            >
              View All <ArrowRight className="w-3 h-3" />
            </button>
          </div>

          {/* Activity Feed Items */}
          <div className="space-y-2.5">
            {latestSignals.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-400 bg-slate-50 rounded-xl border border-slate-100">
                No active signals found for current filter selection.
              </div>
            ) : (
              latestSignals.map((sig) => {
                let badgeStyle = 'bg-slate-100 text-slate-700 border-slate-200';
                if (sig.risk_level === 'Critical' || sig.risk_level === 'High') {
                  badgeStyle = 'bg-rose-50 text-rose-600 border-rose-200';
                } else if (sig.risk_level === 'Medium') {
                  badgeStyle = 'bg-blue-50 text-blue-600 border-blue-200';
                } else {
                  badgeStyle = 'bg-slate-50 text-slate-600 border-slate-200';
                }

                let timeStr = 'Recently';
                try {
                  timeStr = formatDistanceToNow(new Date(sig.ingested_at || sig.published_at), {
                    addSuffix: true
                  });
                } catch {
                  timeStr = 'Recently';
                }

                return (
                  <div
                    key={sig.id}
                    onClick={() => onSelectArticle && onSelectArticle(sig)}
                    className="flex items-start gap-2.5 p-2 rounded-xl hover:bg-slate-50 transition-colors cursor-pointer"
                  >
                    <span
                      className={`text-[9px] font-black uppercase font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${badgeStyle}`}
                    >
                      {sig.risk_level || 'INFO'}
                    </span>
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <h4 className="text-xs font-semibold text-slate-800 leading-snug line-clamp-1 hover:text-rose-600 transition-colors">
                        {sig.title}
                      </h4>
                      <span className="text-[10px] text-slate-400 block font-mono">{timeStr}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
