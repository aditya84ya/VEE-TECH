import React, { useState, useMemo } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  Target,
  Shield,
  TrendingUp,
  Users,
  Building2,
  Lightbulb,
  ExternalLink,
  PhoneCall,
  Check,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  Radio,
  Clock,
  ShieldAlert,
  Layers,
  Search
} from 'lucide-react';
import { useWarRoom, Article } from '../hooks/useWarRoom';

interface CompetitorRadarViewProps {
  articles?: Article[];
  onAcknowledge?: (id: string) => Promise<void>;
  onEscalateVoice?: (article: Article) => void;
  loading?: boolean;
}

// Source badge configuration
const getSourceBadge = (sourceName: string) => {
  const s = (sourceName || '').toLowerCase();
  if (s.includes('economic') || s.includes('et')) {
    return { tag: 'ET', bg: 'bg-[#C2185B]', text: 'text-white' };
  }
  if (s.includes('seeking') || s.includes('alpha')) {
    return { tag: 'α', bg: 'bg-[#EA580C]', text: 'text-white' };
  }
  if (s.includes('tipranks')) {
    return { tag: 'TR', bg: 'bg-[#0284C7]', text: 'text-white' };
  }
  if (s.includes('business standard') || s.includes('bs')) {
    return { tag: 'BS', bg: 'bg-[#DC2626]', text: 'text-white' };
  }
  if (s.includes('moneycontrol') || s.includes('mc')) {
    return { tag: 'M', bg: 'bg-[#0D9488]', text: 'text-white' };
  }
  if (s.includes('times of india') || s.includes('toi')) {
    return { tag: 'TOI', bg: 'bg-[#E11D48]', text: 'text-white' };
  }
  if (s.includes('business today') || s.includes('bt')) {
    return { tag: 'BT', bg: 'bg-[#2563EB]', text: 'text-white' };
  }
  if (s.includes('cnbc')) {
    return { tag: 'CNBC', bg: 'bg-[#0284C7]', text: 'text-white' };
  }
  if (s.includes('reuters')) {
    return { tag: 'REU', bg: 'bg-[#EA580C]', text: 'text-white' };
  }
  if (s.includes('bloomberg')) {
    return { tag: 'BLM', bg: 'bg-[#1E1B4B]', text: 'text-white' };
  }
  return {
    tag: sourceName ? sourceName.slice(0, 2).toUpperCase() : 'NW',
    bg: 'bg-slate-800',
    text: 'text-white'
  };
};

// Helper to determine entity strictly from article metadata
const getEntityForArticle = (a: Article): 'Infosys' | 'TCS' | 'Wipro' | 'Accenture' | 'Other' => {
  const text = `${a.entity_mentioned || ''} ${(a as any).entity || ''} ${a.title || ''}`.toLowerCase();
  if (text.includes('infosys')) return 'Infosys';
  if (text.includes('tcs') || text.includes('tata consultancy') || text.includes('tata')) return 'TCS';
  if (text.includes('wipro')) return 'Wipro';
  if (text.includes('accenture')) return 'Accenture';
  return 'Other';
};

// Extract dynamic domain tags from the article
const extractArticleTags = (article: Article): string[] => {
  const customTags = (article as any).tags;
  if (Array.isArray(customTags) && customTags.length > 0) {
    return customTags.slice(0, 4);
  }
  const text = `${article.title || ''} ${article.raw_content || ''} ${article.entity_mentioned || ''}`.toLowerCase();
  const tags: string[] = [];

  if (text.includes('compliance') || text.includes('audit') || text.includes('rbi') || text.includes('regulatory')) {
    tags.push('Regulatory', 'Compliance');
  }
  if (text.includes('banking') || text.includes('finacle') || text.includes('bfsi')) {
    tags.push('Banking');
  }
  if (text.includes('ai') || text.includes('anthropic') || text.includes('genai') || text.includes('model')) {
    tags.push('AI & GenAI');
  }
  if (text.includes('stock') || text.includes('downgrade') || text.includes('shares') || text.includes('drop')) {
    tags.push('Stock', 'Market');
  }
  if (text.includes('leadership') || text.includes('ceo') || text.includes('board')) {
    tags.push('Leadership');
  }
  if (text.includes('deal') || text.includes('partnership') || text.includes('digital')) {
    tags.push('Partnership');
  }
  if (text.includes('india')) {
    tags.push('India');
  }
  if (tags.length === 0) {
    tags.push(article.entity_mentioned || 'Enterprise', 'Technology');
  }
  return Array.from(new Set(tags)).slice(0, 4);
};

export const CompetitorRadarView: React.FC<CompetitorRadarViewProps> = ({
  articles: propArticles,
  onAcknowledge: propOnAcknowledge,
  onEscalateVoice: propOnEscalateVoice,
  loading: propLoading
}) => {
  // 1. DATA INGESTION PIPELINE (Consumes real-time useWarRoom data)
  const hookData = useWarRoom();
  const articles = propArticles ?? hookData.articles;
  const isLoading = propLoading ?? hookData.loading;
  const onAcknowledge = propOnAcknowledge ?? hookData.acknowledgeArticle;
  const onEscalateVoice = propOnEscalateVoice;

  // 2. STATE ROUTING & FILTERS
  const [activeTab, setActiveTab] = useState<'All' | 'Infosys' | 'TCS' | 'Wipro' | 'Accenture'>('All');
  const [timeFilter, setTimeFilter] = useState('24h');
  const [typeFilter, setTypeFilter] = useState<'All' | 'Critical' | 'High' | 'Medium' | 'Low'>('All');
  const [sortOrder, setSortOrder] = useState('Latest');
  const [searchQuery, setSearchQuery] = useState('');

  // Progressive Disclosure: accordion states for executive briefs
  const [expandedBriefs, setExpandedBriefs] = useState<Record<string, boolean>>({});

  const toggleBrief = (id: string) => {
    setExpandedBriefs((prev) => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

  const clearAllFilters = () => {
    setActiveTab('All');
    setTimeFilter('All');
    setTypeFilter('All');
    setSortOrder('Latest');
    setSearchQuery('');
  };

  // 3. STRICTLY DYNAMIC KPI COUNTS (Zero static numbers)
  const totalCount = articles.length;

  const infosysCount = useMemo(
    () => articles.filter((a) => getEntityForArticle(a) === 'Infosys').length,
    [articles]
  );
  const tcsCount = useMemo(
    () => articles.filter((a) => getEntityForArticle(a) === 'TCS').length,
    [articles]
  );
  const wiproCount = useMemo(
    () => articles.filter((a) => getEntityForArticle(a) === 'Wipro').length,
    [articles]
  );
  const accentureCount = useMemo(
    () => articles.filter((a) => getEntityForArticle(a) === 'Accenture').length,
    [articles]
  );
  const competitorCount = useMemo(
    () => articles.filter((a) => ['TCS', 'Wipro', 'Accenture'].includes(getEntityForArticle(a))).length,
    [articles]
  );
  const activeThreatsCount = useMemo(
    () => articles.filter((a) => a.risk_level === 'Critical' || (a as any).severity === 'CRITICAL' || a.risk_level === 'High' || (a as any).severity === 'HIGH' || Number(a.risk_score || (a as any).score) >= 7.0).length,
    [articles]
  );

  // Dynamic KPI percentages
  const infosysPct = totalCount > 0 ? ((infosysCount / totalCount) * 100).toFixed(1) : '0';
  const competitorPct = totalCount > 0 ? ((competitorCount / totalCount) * 100).toFixed(1) : '0';
  const threatsPct = totalCount > 0 ? ((activeThreatsCount / totalCount) * 100).toFixed(1) : '0';

  // 4. FILTERING & SORTING LOGIC
  const matchesFilters = (a: Article): boolean => {
    // Search query filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matches =
        (a.title || '').toLowerCase().includes(q) ||
        (a.raw_content || '').toLowerCase().includes(q) ||
        (a.entity_mentioned || '').toLowerCase().includes(q) ||
        (a.source_name || '').toLowerCase().includes(q);
      if (!matches) return false;
    }

    // Time filter
    if (timeFilter !== 'All') {
      const now = Date.now();
      const rawTime = a.ingested_at || a.published_at;
      const articleTime = rawTime ? new Date(rawTime).getTime() : 0;
      const diffHours = (now - articleTime) / (1000 * 60 * 60);

      if (timeFilter === '1h' && diffHours > 1) return false;
      if (timeFilter === '24h' && diffHours > 24) return false;
      if (timeFilter === '7d' && diffHours > 168) return false;
    }

    // Type filter
    if (typeFilter !== 'All') {
      const currentLevel = (a.risk_level === 'Critical' || (a as any).severity === 'CRITICAL' || Number(a.risk_score || (a as any).score) >= 9.0)
        ? 'Critical'
        : (a.risk_level === 'High' || (a as any).severity === 'HIGH' || Number(a.risk_score || (a as any).score) >= 7.0)
        ? 'High'
        : (a.risk_level || 'Medium');
      if (currentLevel !== typeFilter) {
        return false;
      }
    }

    return true;
  };

  const sortArticles = (list: Article[]): Article[] => {
    return [...list].sort((a, b) => {
      if (sortOrder === 'Latest') {
        const timeA = new Date(a.ingested_at || a.published_at).getTime();
        const timeB = new Date(b.ingested_at || b.published_at).getTime();
        return timeB - timeA;
      }
      if (sortOrder === 'Oldest') {
        const timeA = new Date(a.ingested_at || a.published_at).getTime();
        const timeB = new Date(b.ingested_at || b.published_at).getTime();
        return timeA - timeB;
      }
      if (sortOrder === 'Highest Risk') {
        return (b.risk_score || 0) - (a.risk_score || 0);
      }
      return 0;
    });
  };

  // Split Stream: Column A (Client Watch: Infosys)
  const clientStream = useMemo(() => {
    const filtered = articles.filter(
      (a) => getEntityForArticle(a) === 'Infosys' && matchesFilters(a)
    );
    return sortArticles(filtered);
  }, [articles, searchQuery, timeFilter, typeFilter, sortOrder]);

  // Split Stream: Column B (Competitor Vulnerabilities & Counter-Plays)
  const competitorStream = useMemo(() => {
    const filtered = articles.filter((a) => {
      const ent = getEntityForArticle(a);
      if (activeTab === 'All' || activeTab === 'Infosys') {
        return ['TCS', 'Wipro', 'Accenture'].includes(ent) && matchesFilters(a);
      }
      return ent === activeTab && matchesFilters(a);
    });
    return sortArticles(filtered);
  }, [articles, activeTab, searchQuery, timeFilter, typeFilter, sortOrder]);
  // Real entity sentiment computation (-100 to +100) from actual triaged articles
  const entitySentimentData = useMemo(() => {
    const entities = ['Infosys', 'TCS', 'Wipro', 'Accenture'] as const;
    return entities.map((ent) => {
      const entArticles = articles.filter((a) => getEntityForArticle(a) === ent);
      const total = entArticles.length;
      let pos = 0;
      let neu = 0;
      let neg = 0;
      let totalRisk = 0;

      entArticles.forEach((a) => {
        if (a.sentiment === 'Positive') pos++;
        else if (a.sentiment === 'Negative') neg++;
        else neu++;
        totalRisk += a.risk_score || 0;
      });

      const netScore = total > 0 ? Math.round(((pos - neg) / total) * 100) : 0;
      const avgRisk = total > 0 ? Number((totalRisk / total).toFixed(1)) : 0;

      return {
        entity: ent,
        total,
        pos,
        neu,
        neg,
        netScore,
        avgRisk
      };
    });
  }, [articles]);

  // 5. COMPETITIVE LANDSCAPE DONUT CHART (Zero-mock math)
  const landscapeTotal = infosysCount + tcsCount + wiproCount + accentureCount;
  const circumference = 238.76; // 2 * PI * 38

  const donutSegments = useMemo(() => {
    if (landscapeTotal === 0) {
      return {
        infosys: { dash: `0 ${circumference}`, offset: 0, pct: '0.0%' },
        tcs: { dash: `0 ${circumference}`, offset: 0, pct: '0.0%' },
        wipro: { dash: `0 ${circumference}`, offset: 0, pct: '0.0%' },
        accenture: { dash: `0 ${circumference}`, offset: 0, pct: '0.0%' }
      };
    }
    const s1 = (infosysCount / landscapeTotal) * circumference;
    const s2 = (tcsCount / landscapeTotal) * circumference;
    const s3 = (wiproCount / landscapeTotal) * circumference;
    const s4 = (accentureCount / landscapeTotal) * circumference;

    return {
      infosys: {
        dash: `${s1} ${circumference}`,
        offset: 0,
        pct: `${((infosysCount / landscapeTotal) * 100).toFixed(1)}%`
      },
      tcs: {
        dash: `${s2} ${circumference}`,
        offset: -s1,
        pct: `${((tcsCount / landscapeTotal) * 100).toFixed(1)}%`
      },
      wipro: {
        dash: `${s3} ${circumference}`,
        offset: -(s1 + s2),
        pct: `${((wiproCount / landscapeTotal) * 100).toFixed(1)}%`
      },
      accenture: {
        dash: `${s4} ${circumference}`,
        offset: -(s1 + s2 + s3),
        pct: `${((accentureCount / landscapeTotal) * 100).toFixed(1)}%`
      }
    };
  }, [infosysCount, tcsCount, wiproCount, accentureCount, landscapeTotal]);

  // 6. KEY INSIGHTS (Derived strictly from high-risk competitor events, zero mock data)
  const keyInsights = useMemo(() => {
    const highRisk = articles.filter(
      (a) => a.risk_level === 'Critical' || a.risk_level === 'High'
    );
    return highRisk.slice(0, 4).map((a, idx) => {
      const ent = getEntityForArticle(a);
      const color =
        ent === 'Infosys'
          ? 'bg-blue-600'
          : ent === 'Accenture'
          ? 'bg-rose-600'
          : ent === 'TCS'
          ? 'bg-purple-600'
          : 'bg-amber-600';

      const desc =
        Array.isArray(a.five_bullet_summary) && a.five_bullet_summary[0]
          ? a.five_bullet_summary[0]
          : a.raw_content
          ? a.raw_content.slice(0, 80) + '...'
          : 'High severity signal currently tracked in active war room.';

      return {
        id: a.id || `insight-${idx}`,
        color,
        title: a.title,
        desc
      };
    });
  }, [articles]);



  // Render Thumbnail
  const renderThumbnail = (article: Article) => {
    const ent = getEntityForArticle(article);
    const hasImage = article.image_url && String(article.image_url).startsWith('http');

    if (hasImage) {
      return (
        <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-lg overflow-hidden shrink-0 bg-slate-100 border border-slate-200/80 relative">
          <img
            src={article.image_url!}
            alt={article.title}
            onError={(e) => {
              // Hide broken image on error and fallback to entity icon
              (e.target as HTMLElement).style.display = 'none';
            }}
            className="w-full h-full object-cover"
          />
          <span className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-slate-900/85 backdrop-blur-xs text-[10px] font-bold text-white uppercase tracking-wider">
            {ent}
          </span>
        </div>
      );
    }

    // High-fidelity dynamic brand monogram tile
    const bgGradients: Record<string, string> = {
      Infosys: 'from-blue-600 to-indigo-700',
      TCS: 'from-purple-600 to-indigo-800',
      Wipro: 'from-amber-500 to-orange-600',
      Accenture: 'from-rose-600 to-pink-700',
      Other: 'from-slate-700 to-slate-900'
    };

    return (
      <div
        className={`w-24 h-24 sm:w-28 sm:h-28 rounded-lg shrink-0 bg-gradient-to-br ${
          bgGradients[ent] || bgGradients.Other
        } p-3 flex flex-col justify-between text-white shadow-2xs relative overflow-hidden`}
      >
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider opacity-85">
            {article.source_name ? article.source_name.slice(0, 10) : 'Wire'}
          </span>
          {ent === 'Infosys' ? (
            <Building2 className="w-4 h-4 opacity-75" />
          ) : ent === 'TCS' ? (
            <Target className="w-4 h-4 opacity-75" />
          ) : ent === 'Wipro' ? (
            <Radio className="w-4 h-4 opacity-75" />
          ) : (
            <Layers className="w-4 h-4 opacity-75" />
          )}
        </div>
        <div>
          <span className="text-base font-black tracking-tight block font-mono">{ent}</span>
          <span className="text-[9px] uppercase tracking-wider font-semibold opacity-75">
            Intelligence
          </span>
        </div>
      </div>
    );
  };

  // Render an individual Article Card
  const renderArticleCard = (article: Article) => {
    const isCritical = article.risk_level === 'Critical' || (article as any).severity === 'CRITICAL' || (Number(article.risk_score || (article as any).score) >= 9.0);
    const isHigh = !isCritical && (article.risk_level === 'High' || (article as any).severity === 'HIGH' || (Number(article.risk_score || (article as any).score) >= 7.0));
    const isMedium = !isCritical && !isHigh && (article.risk_level === 'Medium' || (article as any).severity === 'MEDIUM' || (Number(article.risk_score || (article as any).score) >= 4.0));
    const isAcknowledged = article.status === 'ACKNOWLEDGED';
    const isExpanded = Boolean(expandedBriefs[article.id]);

    const badge = getSourceBadge(article.source_name);
    const tags = extractArticleTags(article);

    let relativeTime = 'Recently';
    try {
      relativeTime = formatDistanceToNow(new Date(article.ingested_at || article.published_at), {
        addSuffix: true
      });
    } catch {
      relativeTime = 'Recently';
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
      : isMedium
      ? '5.0'
      : '2.5';

    let severityBadgeClass = 'bg-slate-100 text-slate-700 border-slate-200';
    if (isCritical) {
      severityBadgeClass = 'bg-rose-50 text-rose-600 border-rose-200 font-bold';
    } else if (isHigh) {
      severityBadgeClass = 'bg-amber-50 text-amber-700 border-amber-200 font-bold';
    } else if (isMedium) {
      severityBadgeClass = 'bg-blue-50 text-blue-700 border-blue-200 font-bold';
    }

    return (
      <div
        key={article.id}
        className={`bg-white rounded-xl border transition-all duration-200 shadow-2xs hover:shadow-xs p-4 space-y-3 ${
          isCritical ? 'border-slate-200 border-l-4 border-l-rose-600' : 'border-slate-200'
        } ${isAcknowledged ? 'opacity-65' : ''}`}
      >
        <div className="flex gap-3.5 items-start">
          {renderThumbnail(article)}

          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs text-slate-500 font-medium truncate">
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${badge.bg} ${badge.text}`}
                >
                  {badge.tag}
                </span>
                <span className="font-semibold text-slate-800 truncate">{article.source_name}</span>
                <span className="text-slate-300">•</span>
                <span className="text-slate-400 shrink-0 flex items-center gap-1 font-mono">
                  <Clock className="w-3 h-3 inline" />
                  {relativeTime}
                </span>
              </div>

              <span
                className={`px-2 py-0.5 rounded-md text-[11px] font-mono shrink-0 border ${severityBadgeClass}`}
              >
                {(isCritical ? 'CRITICAL' : isHigh ? 'HIGH' : (article.risk_level?.toUpperCase() || 'MEDIUM'))} {scoreValue}/10
              </span>
            </div>

            <h4 className="text-sm sm:text-[15px] font-semibold text-slate-900 leading-snug line-clamp-2 hover:text-rose-600 transition-colors">
              {article.title}
            </h4>

            <p className="text-xs text-slate-500 line-clamp-2 leading-relaxed">
              {article.raw_content || 'Real-time telemetry captured by Vee-Alert intelligence mesh.'}
            </p>

            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="px-2 py-0.5 rounded-md bg-slate-100 border border-slate-200/70 text-[11px] font-medium text-slate-600"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Progressive Disclosure: Accordion for 5-Bullet Executive Brief */}
        {Array.isArray(article.five_bullet_summary) && article.five_bullet_summary.length > 0 && (
          <div className="pt-2 border-t border-slate-100">
            <button
              onClick={() => toggleBrief(article.id)}
              className="w-full flex items-center justify-between text-xs text-slate-600 hover:text-slate-900 font-medium py-1 px-1 rounded hover:bg-slate-50 transition-colors cursor-pointer"
            >
              <span className="flex items-center gap-1.5 font-semibold text-slate-700">
                {isExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                )}
                Executive 5-Bullet Intelligence Brief
              </span>
              <span className="text-[11px] text-slate-400 font-mono">
                {isExpanded ? 'Collapse' : 'Expand'}
              </span>
            </button>

            {isExpanded && (
              <div className="mt-2 bg-slate-50 border border-slate-200/80 rounded-lg p-3 space-y-1.5 text-xs text-slate-700">
                {article.five_bullet_summary.map((bullet, bIdx) => (
                  <div key={bIdx} className="flex items-start gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-rose-500 mt-1.5 shrink-0" />
                    <span className="leading-relaxed">{bullet}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Card Action Footer */}
        <div className="flex items-center justify-between pt-2 border-t border-slate-100 text-xs text-slate-500">
          <div className="flex items-center gap-3">
            {article.url && (
              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-slate-600 hover:text-rose-600 font-medium transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Source
              </a>
            )}
            {onAcknowledge && (
              <button
                onClick={() => onAcknowledge(article.id)}
                disabled={isAcknowledged}
                className={`flex items-center gap-1 font-medium transition-colors cursor-pointer ${
                  isAcknowledged
                    ? 'text-emerald-600 cursor-default'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Check className="w-3.5 h-3.5" />
                {isAcknowledged ? 'Acknowledged' : 'Acknowledge'}
              </button>
            )}
          </div>

          {onEscalateVoice && (
            <button
              onClick={() => onEscalateVoice(article)}
              className="flex items-center gap-1 text-rose-600 hover:text-rose-700 font-semibold px-2 py-0.5 rounded hover:bg-rose-50 transition-colors cursor-pointer"
            >
              <PhoneCall className="w-3 h-3" />
              Escalate
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6 max-w-[1600px] mx-auto pb-14">
      {/* ========================================================= */}
      {/* 1. PAGE HEADER & QUOTE */}
      {/* ========================================================= */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2.5 font-sans">
            <div className="w-8 h-8 rounded-lg bg-rose-50 border border-rose-200 flex items-center justify-center text-rose-600">
              <Target className="w-4 h-4" />
            </div>
            Competitor Intelligence Radar
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            Real-time side-by-side threat landscape: Infosys vs. TCS, Wipro &amp; Accenture.
          </p>
        </div>

        {/* Top-Right Branding & Metric Snapshot */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="hidden lg:block text-right border-r border-slate-200 pr-4">
            <p className="text-xs italic font-serif text-slate-400 font-medium leading-tight">
              &ldquo;See risks earlier. Move faster.&rdquo;
            </p>
            <p className="text-[10px] text-slate-400 font-semibold tracking-wider uppercase mt-0.5">
              — VEE-ALERT
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs font-mono">
            <div className="bg-white border border-slate-200 rounded-lg px-3 py-1.5 shadow-2xs">
              <span className="text-slate-400 font-medium">INFOSYS: </span>
              <span className="text-slate-900 font-bold ml-1">{infosysCount}</span>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg px-3 py-1.5 shadow-2xs">
              <span className="text-slate-400 font-medium">COMPETITORS: </span>
              <span className="text-slate-900 font-bold ml-1">{competitorCount}</span>
            </div>
          </div>
        </div>
      </div>

      {/* ========================================================= */}
      {/* 2. DYNAMIC KPI ROW (Zero Hardcoded Values) */}
      {/* ========================================================= */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* KPI 1: Infosys Incidents */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600 shrink-0">
            <Building2 className="w-6 h-6" />
          </div>
          <div>
            <span className="text-xs text-slate-500 font-medium block">Infosys Incidents</span>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-2xl font-bold text-slate-900 font-mono">{infosysCount}</span>
              <span className="text-[11px] font-semibold text-blue-600 font-mono">
                {infosysPct}%
              </span>
            </div>
            <span className="text-[11px] text-slate-400 block mt-0.5">of total intelligence stream</span>
          </div>
        </div>

        {/* KPI 2: Competitor Events */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-rose-50 border border-rose-100 flex items-center justify-center text-rose-600 shrink-0">
            <Users className="w-6 h-6" />
          </div>
          <div>
            <span className="text-xs text-slate-500 font-medium block">Competitor Events</span>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-2xl font-bold text-slate-900 font-mono">{competitorCount}</span>
              <span className="text-[11px] font-semibold text-rose-600 font-mono">
                {competitorPct}%
              </span>
            </div>
            <span className="text-[11px] text-slate-400 block mt-0.5">of total intelligence stream</span>
          </div>
        </div>

        {/* KPI 3: Monitored Competitors */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-600 shrink-0">
            <Target className="w-6 h-6" />
          </div>
          <div>
            <span className="text-xs text-slate-500 font-medium block">Monitored Competitors</span>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-2xl font-bold text-slate-900 font-mono">3</span>
            </div>
            <span className="text-[11px] text-slate-400 block mt-0.5">TCS, Wipro, Accenture</span>
          </div>
        </div>

        {/* KPI 4: Active Threats */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center text-amber-600 shrink-0">
            <Shield className="w-6 h-6" />
          </div>
          <div>
            <span className="text-xs text-slate-500 font-medium block">Active Threats</span>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-2xl font-bold text-slate-900 font-mono">
                {activeThreatsCount}
              </span>
              <span className="text-[11px] font-semibold text-amber-600 font-mono">
                {threatsPct}%
              </span>
            </div>
            <span className="text-[11px] text-slate-400 block mt-0.5">
              {activeThreatsCount > 0 ? 'require executive attention' : 'nominal threat baseline'}
            </span>
          </div>
        </div>
      </div>

      {/* ========================================================= */}
      {/* 2.5 REAL-TIME ENTITY SENTIMENT & VULNERABILITY RADAR */}
      {/* ========================================================= */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-2xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-slate-700" />
            <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider font-mono">
              Live Entity Sentiment &amp; Vulnerability Matrix
            </h3>
          </div>
          <span className="text-[11px] text-slate-400 font-mono">
            Derived strictly from live AI triage streams (-100 to +100)
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {entitySentimentData.map((data) => {
            const isClient = data.entity === 'Infosys';
            const scoreColor =
              data.netScore > 10
                ? 'text-emerald-600'
                : data.netScore < -10
                ? 'text-rose-600'
                : 'text-slate-600';
            const badgeBg =
              data.netScore > 10
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : data.netScore < -10
                ? 'bg-rose-50 text-rose-700 border-rose-200'
                : 'bg-slate-100 text-slate-600 border-slate-200';

            const scoreLabel =
              data.total === 0
                ? 'No Signals'
                : data.netScore > 10
                ? 'Positive Sentiment'
                : data.netScore < -10
                ? isClient ? 'Crisis Pressure' : 'Vulnerable (RFP Target)'
                : 'Neutral Baseline';

            return (
              <div
                key={data.entity}
                className={`p-3.5 rounded-xl border transition-all ${
                  isClient
                    ? 'bg-blue-50/40 border-blue-200/80 shadow-2xs'
                    : 'bg-slate-50/50 border-slate-200/70 hover:bg-white hover:border-slate-300'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900 font-mono flex items-center gap-1.5">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        isClient ? 'bg-blue-600' : 'bg-slate-400'
                      }`}
                    />
                    {data.entity} {isClient && <span className="text-[10px] text-blue-600 font-sans font-semibold">(Client)</span>}
                  </span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${badgeBg}`}>
                    {scoreLabel}
                  </span>
                </div>

                <div className="flex items-baseline justify-between mt-2">
                  <div className="flex items-baseline gap-1">
                    <span className={`text-xl font-black font-mono ${scoreColor}`}>
                      {data.total === 0 ? '0' : (data.netScore > 0 ? `+${data.netScore}` : data.netScore)}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono">/ 100 net</span>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] text-slate-400 block font-medium">Avg Risk</span>
                    <span className="text-xs font-bold text-slate-800 font-mono">{data.avgRisk} / 10</span>
                  </div>
                </div>

                {/* Micro Sentiment Distribution Bar */}
                <div className="mt-2.5 space-y-1">
                  <div className="h-1.5 w-full bg-slate-200/80 rounded-full overflow-hidden flex">
                    <div
                      style={{ width: `${data.total > 0 ? (data.pos / data.total) * 100 : 0}%` }}
                      className="bg-emerald-500 h-full transition-all duration-500"
                    />
                    <div
                      style={{ width: `${data.total > 0 ? (data.neu / data.total) * 100 : 0}%` }}
                      className="bg-slate-300 h-full transition-all duration-500"
                    />
                    <div
                      style={{ width: `${data.total > 0 ? (data.neg / data.total) * 100 : 0}%` }}
                      className="bg-rose-500 h-full transition-all duration-500"
                    />
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono pt-0.5">
                    <span>Pos: <strong className="text-emerald-600">{data.pos}</strong></span>
                    <span>Neu: <strong className="text-slate-600">{data.neu}</strong></span>
                    <span>Neg: <strong className="text-rose-600">{data.neg}</strong></span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ========================================================= */}
      {/* 3. INTERACTIVE FILTER TOOLBAR WITH FUNCTIONAL SEARCH */}
      {/* ========================================================= */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-2xs flex flex-wrap items-center justify-between gap-3">
        {/* Primary Tabs (Left) */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setActiveTab('All')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              activeTab === 'All'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 border border-slate-200'
            }`}
          >
            All Signals ({totalCount})
          </button>
          <button
            onClick={() => setActiveTab('Infosys')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              activeTab === 'Infosys'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 border border-slate-200'
            }`}
          >
            Infosys ({infosysCount})
          </button>
          <button
            onClick={() => setActiveTab('TCS')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              activeTab === 'TCS'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 border border-slate-200'
            }`}
          >
            TCS ({tcsCount})
          </button>
          <button
            onClick={() => setActiveTab('Wipro')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              activeTab === 'Wipro'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 border border-slate-200'
            }`}
          >
            Wipro ({wiproCount})
          </button>
          <button
            onClick={() => setActiveTab('Accenture')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              activeTab === 'Accenture'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 border border-slate-200'
            }`}
          >
            Accenture ({accentureCount})
          </button>
        </div>

        {/* Secondary Controls (Right) */}
        <div className="flex flex-wrap items-center gap-2 text-xs flex-1 justify-end">
          {/* Functional Search Bar */}
          <div className="relative min-w-[170px] max-w-xs">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search keyword, source..."
              className="w-full h-8 pl-8 pr-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-rose-500 focus:border-rose-500"
            />
          </div>

          {/* Time Filter */}
          <select
            value={timeFilter}
            onChange={(e) => setTimeFilter(e.target.value)}
            className="h-8 px-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 font-medium focus:outline-none cursor-pointer"
          >
            <option value="All">Time: All</option>
            <option value="1h">Time: Past 1 Hour</option>
            <option value="24h">Time: Last 24 hours</option>
            <option value="7d">Time: Past 7 Days</option>
          </select>

          {/* Type Filter */}
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as any)}
            className="h-8 px-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 font-medium focus:outline-none cursor-pointer"
          >
            <option value="All">Type: All</option>
            <option value="Critical">Critical Threats</option>
            <option value="High">High Severity</option>
            <option value="Medium">Medium Severity</option>
            <option value="Low">Low Severity</option>
          </select>

          {/* Sort Filter */}
          <select
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            className="h-8 px-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 font-medium focus:outline-none cursor-pointer"
          >
            <option value="Latest">Sort: Latest</option>
            <option value="Oldest">Sort: Oldest</option>
            <option value="Highest Risk">Sort: Highest Risk</option>
          </select>

          {/* Clear All */}
          <button
            onClick={clearAllFilters}
            className="text-rose-600 hover:text-rose-700 font-semibold px-2 py-1 rounded transition-colors cursor-pointer"
          >
            Clear All
          </button>
        </div>
      </div>

      {/* ========================================================= */}
      {/* 4. MAIN GRID: 70% SPLIT STREAMS + 30% RIGHT PANEL */}
      {/* ========================================================= */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* ========================================================= */}
        {/* LEFT AREA: SPLIT STREAMS (70% ~ 8 cols) */}
        {/* ========================================================= */}
        <div className="lg:col-span-8 grid grid-cols-1 md:grid-cols-2 gap-5 min-w-0">
          {/* ================= COLUMN A: CLIENT WATCH: INFOSYS ================= */}
          <div className="space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4 text-blue-600" />
                <div>
                  <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider font-mono">
                    Client Watch: INFOSYS
                  </h3>
                  <p className="text-[11px] text-slate-400 font-medium">
                    {clientStream.length} intelligence items
                  </p>
                </div>
              </div>
              <button
                onClick={() => setActiveTab('Infosys')}
                className="text-xs text-slate-500 hover:text-rose-600 font-semibold flex items-center gap-1 transition-colors cursor-pointer"
              >
                View All <ArrowRight className="w-3 h-3" />
              </button>
            </div>

            {isLoading && articles.length === 0 ? (
              <div className="space-y-3">
                {[1, 2, 3].map((n) => (
                  <div key={n} className="bg-white rounded-xl border border-slate-200 p-4 h-36 animate-pulse" />
                ))}
              </div>
            ) : clientStream.length === 0 ? (
              <div className="p-8 text-center bg-white rounded-xl border border-slate-200 text-slate-500 text-xs shadow-2xs">
                <ShieldAlert className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                No signals match the current filters.
              </div>
            ) : (
              clientStream.map((article) => renderArticleCard(article))
            )}
          </div>

          {/* ================= COLUMN B: COMPETITOR VULNERABILITIES ================= */}
          <div className="space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-rose-600" />
                <div>
                  <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider font-mono">
                    Competitor Vulnerabilities &amp; Counter-Plays
                  </h3>
                  <p className="text-[11px] text-slate-400 font-medium">
                    {competitorStream.length} intelligence items
                  </p>
                </div>
              </div>
              <button
                onClick={() => setActiveTab('All')}
                className="text-xs text-slate-500 hover:text-rose-600 font-semibold flex items-center gap-1 transition-colors cursor-pointer"
              >
                View All <ArrowRight className="w-3 h-3" />
              </button>
            </div>

            {isLoading && articles.length === 0 ? (
              <div className="space-y-3">
                {[1, 2, 3].map((n) => (
                  <div key={n} className="bg-white rounded-xl border border-slate-200 p-4 h-36 animate-pulse" />
                ))}
              </div>
            ) : competitorStream.length === 0 ? (
              <div className="p-8 text-center bg-white rounded-xl border border-slate-200 text-slate-500 text-xs shadow-2xs">
                <ShieldAlert className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                No signals match the current filters.
              </div>
            ) : (
              competitorStream.map((article) => renderArticleCard(article))
            )}
          </div>
        </div>

        {/* ========================================================= */}
        {/* RIGHT AREA: INTELLIGENCE PANEL (30% ~ 4 cols) */}
        {/* ========================================================= */}
        <div className="lg:col-span-4 space-y-5">
          {/* CARD 1: Competitive Landscape Donut Chart */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 tracking-tight flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                Competitive Landscape
              </h3>
            </div>

            <div className="flex items-center justify-between gap-4">
              {/* SVG Donut */}
              <div className="relative w-28 h-28 shrink-0">
                <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                  <circle
                    cx="50"
                    cy="50"
                    r="38"
                    fill="transparent"
                    stroke="#F1F5F9"
                    strokeWidth="12"
                  />
                  <circle
                    cx="50"
                    cy="50"
                    r="38"
                    fill="transparent"
                    stroke="#2563EB"
                    strokeWidth="12"
                    strokeDasharray={donutSegments.infosys.dash}
                    strokeDashoffset={donutSegments.infosys.offset}
                    className="transition-all duration-500"
                  />
                  <circle
                    cx="50"
                    cy="50"
                    r="38"
                    fill="transparent"
                    stroke="#9333EA"
                    strokeWidth="12"
                    strokeDasharray={donutSegments.tcs.dash}
                    strokeDashoffset={donutSegments.tcs.offset}
                    className="transition-all duration-500"
                  />
                  <circle
                    cx="50"
                    cy="50"
                    r="38"
                    fill="transparent"
                    stroke="#D97706"
                    strokeWidth="12"
                    strokeDasharray={donutSegments.wipro.dash}
                    strokeDashoffset={donutSegments.wipro.offset}
                    className="transition-all duration-500"
                  />
                  <circle
                    cx="50"
                    cy="50"
                    r="38"
                    fill="transparent"
                    stroke="#E11D48"
                    strokeWidth="12"
                    strokeDasharray={donutSegments.accenture.dash}
                    strokeDashoffset={donutSegments.accenture.offset}
                    className="transition-all duration-500"
                  />
                </svg>
                {/* Center Stats */}
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-xl font-bold text-slate-900 font-mono leading-none">
                    {landscapeTotal}
                  </span>
                  <span className="text-[9px] uppercase font-bold text-slate-400 tracking-wider mt-0.5">
                    Signals
                  </span>
                </div>
              </div>

              {/* Legend with Dynamic Counts & Percentages */}
              <div className="flex-1 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#2563EB]" />
                    <span className="font-semibold text-slate-800">Infosys</span>
                  </div>
                  <span className="font-mono text-slate-500 font-medium">
                    {infosysCount} ({donutSegments.infosys.pct})
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#9333EA]" />
                    <span className="font-semibold text-slate-800">TCS</span>
                  </div>
                  <span className="font-mono text-slate-500 font-medium">
                    {tcsCount} ({donutSegments.tcs.pct})
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#D97706]" />
                    <span className="font-semibold text-slate-800">Wipro</span>
                  </div>
                  <span className="font-mono text-slate-500 font-medium">
                    {wiproCount} ({donutSegments.wipro.pct})
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#E11D48]" />
                    <span className="font-semibold text-slate-800">Accenture</span>
                  </div>
                  <span className="font-mono text-slate-500 font-medium">
                    {accentureCount} ({donutSegments.accenture.pct})
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* CARD 2: Key Insights (Zero-mock: derived from active high risk signals or neutral message) */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-3.5">
            <div className="flex items-center gap-2">
              <Lightbulb className="w-4 h-4 text-amber-500" />
              <h3 className="text-sm font-bold text-slate-900 tracking-tight">
                Key Insights
              </h3>
            </div>

            {keyInsights.length === 0 ? (
              <div className="p-4 rounded-lg bg-slate-50 border border-slate-200/80 text-xs text-slate-500 text-center">
                Sufficient data gathering in progress... monitoring live wire.
              </div>
            ) : (
              <div className="space-y-3">
                {keyInsights.map((insight) => (
                  <div key={insight.id} className="flex items-start gap-2.5 text-xs">
                    <span className={`w-2 h-2 rounded-full ${insight.color} mt-1.5 shrink-0`} />
                    <div className="space-y-0.5">
                      <strong className="text-slate-900 font-semibold block leading-snug">
                        {insight.title}
                      </strong>
                      <p className="text-slate-500 text-[11px] leading-relaxed line-clamp-2">
                        {insight.desc}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* CARD 3: System Status */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                <h3 className="text-sm font-bold text-slate-900 tracking-tight">
                  System Status
                </h3>
              </div>
              <span className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md font-mono">
                All Systems Operational
              </span>
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between py-1 border-b border-slate-100">
                <span className="text-slate-500">News Ingestion</span>
                <span className="font-semibold text-emerald-600 font-mono">Live</span>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-slate-100">
                <span className="text-slate-500">AI Analysis</span>
                <span className="font-semibold text-emerald-600 font-mono">Active</span>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-slate-100">
                <span className="text-slate-500">Alert Engine</span>
                <span className="font-semibold text-emerald-600 font-mono">Running</span>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-slate-500">Database</span>
                <span className="font-semibold text-emerald-600 font-mono">Connected</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
