import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useOutletContext } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { DashboardView } from './components/DashboardView';
import { CrisisWarRoomView } from './components/CrisisWarRoomView';
import { CompetitorRadarView } from './components/CompetitorRadarView';
import { SlaProofEngineView } from './components/SlaProofEngineView';
import { IntelligenceTrendAnalysisView } from './components/IntelligenceTrendAnalysisView';
import { IntelligenceSourcesView } from './components/IntelligenceSourcesView';
import { ManualUploadView } from './components/ManualUploadView';
import { Article } from './hooks/useWarRoom';
import { WarRoomProvider } from './context/WarRoomContext';
import {
  TrendingUp,
  FileText,
  Database,
  Bell,
  CheckCircle2,
  Compass
} from 'lucide-react';

// Context interface shared from AppShell Outlet
export interface OutletContextType {
  articles: Article[];
  loading: boolean;
  isRealtimeActive: boolean;
  searchQuery: string;
  onSelectArticle: (art: Article) => void;
  onAcknowledge: (id: string) => Promise<void>;
  onEscalateVoice: (art: Article) => void;
  onNavigateToWarRoom: () => void;
}

// 1. Routed Views wrapping existing view components using Outlet Context
function DashboardRoute() {
  const ctx = useOutletContext<OutletContextType>();
  return (
    <DashboardView
      articles={ctx.articles}
      onNavigateToWarRoom={ctx.onNavigateToWarRoom}
      onSelectArticle={ctx.onSelectArticle}
      searchQuery={ctx.searchQuery}
      isRealtimeActive={ctx.isRealtimeActive}
    />
  );
}

function CrisisWarRoomRoute() {
  const ctx = useOutletContext<OutletContextType>();
  return (
    <CrisisWarRoomView
      articles={ctx.articles}
      onAcknowledge={ctx.onAcknowledge}
      onEscalateVoice={ctx.onEscalateVoice}
      loading={ctx.loading}
    />
  );
}

function CompetitorRadarRoute() {
  const ctx = useOutletContext<OutletContextType>();
  return (
    <CompetitorRadarView
      articles={ctx.articles}
      onAcknowledge={ctx.onAcknowledge}
      onEscalateVoice={ctx.onEscalateVoice}
      loading={ctx.loading}
    />
  );
}

function SlaProofEngineRoute() {
  const ctx = useOutletContext<OutletContextType>();
  return <SlaProofEngineView articles={ctx.articles} />;
}

function ManualUploadRoute() {
  return <ManualUploadView />;
}

// 2. Analysis Route
function AnalysisRoute() {
  const { articles, onSelectArticle } = useOutletContext<OutletContextType>();
  return <IntelligenceTrendAnalysisView articles={articles} onSelectArticle={onSelectArticle} />;
}

// 3. Reports Route
function ReportsRoute() {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-8 shadow-2xs space-y-6">
      <div className="flex items-center gap-3 border-b border-slate-100 pb-4">
        <FileText className="w-6 h-6 text-rose-600" />
        <div>
          <h2 className="text-xl font-bold text-slate-900">Executive Intelligence Dossiers</h2>
          <p className="text-xs text-slate-500">Automated C-Suite briefs ready for instant export.</p>
        </div>
      </div>
      <div className="space-y-3">
        {[
          { title: 'Infosys Brand Threat Vector - Daily Brief', date: 'Today, 06:00 AM', status: 'Ready' },
          { title: 'Competitor Pricing & Deal Vulnerability Analysis', date: 'Yesterday', status: 'Archived' },
          { title: 'SLA Audit & Zero-Latency Proof Certificate', date: 'Sep 18, 2026', status: 'Verified' }
        ].map((rep, idx) => (
          <div key={idx} className="flex items-center justify-between p-4 rounded-lg bg-slate-50 border border-slate-200/80">
            <div>
              <h4 className="text-sm font-bold text-slate-900">{rep.title}</h4>
              <span className="text-xs text-slate-500">{rep.date}</span>
            </div>
            <span className="px-2.5 py-1 text-xs font-semibold rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
              {rep.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// 4. News Feed Route
function NewsFeedRoute() {
  const { articles, onSelectArticle } = useOutletContext<OutletContextType>();

  return (
    <div className="space-y-4">
      <div className="border-b border-slate-200 pb-3">
        <h2 className="text-xl font-bold text-slate-900">Real-Time Ingestion News Wire</h2>
        <p className="text-xs text-slate-500">Complete raw streaming telemetry across all verified wire sources.</p>
      </div>
      <div className="space-y-3">
        {articles.map((art) => (
          <div
            key={art.id}
            onClick={() => onSelectArticle(art)}
            className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs hover:shadow-xs transition-all space-y-1.5 cursor-pointer"
          >
            <div className="flex justify-between text-xs text-slate-500">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-slate-700">{art.source_name}</span>
                {((art.api_source || '').toLowerCase().includes('manual')) && (
                  <span className="px-1.5 py-0.2 rounded bg-purple-100 text-purple-800 text-[9px] uppercase font-bold tracking-wider border border-purple-300">
                    MANUAL UPLOAD
                  </span>
                )}
              </div>
              <span>Target: <strong className="text-slate-900">{art.entity_mentioned}</strong></span>
            </div>
            <h4 className="text-sm font-bold text-slate-900">{art.title}</h4>
            <p className="text-xs text-slate-600 line-clamp-2">{art.raw_content}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// 5. Sources Route
function SourcesRoute() {
  const { articles } = useOutletContext<OutletContextType>();
  return <IntelligenceSourcesView articles={articles} />;
}

// 6. Alerts Route
function AlertsRoute() {
  const { articles, onEscalateVoice } = useOutletContext<OutletContextType>();
  const alertArticles = articles.filter(
    (a) => a.risk_level === 'Critical' || (typeof a.risk_score === 'number' && a.risk_score >= 9.0)
  );

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-8 shadow-2xs space-y-6">
      <div className="flex items-center gap-3 border-b border-slate-100 pb-4">
        <Bell className="w-6 h-6 text-rose-600" />
        <div>
          <h2 className="text-xl font-bold text-slate-900">Active High-Priority Alerts</h2>
          <p className="text-xs text-slate-500">Articles flagged as Critical requiring immediate executive response.</p>
        </div>
      </div>
      <div className="space-y-3">
        {alertArticles.length === 0 ? (
          <div className="p-8 text-center text-slate-400 text-sm">No critical alerts at this time.</div>
        ) : (
          alertArticles.map((art) => (
            <div key={art.id} className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1 max-w-xl">
                <div className="flex items-center gap-2 text-xs">
                  <span
                    className={`px-2 py-0.5 rounded font-bold font-mono text-[11px] ${
                      art.risk_level === 'Critical'
                        ? 'bg-rose-100 text-rose-700'
                        : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    {art.risk_level}
                  </span>
                  <span className="text-slate-500">{art.entity_mentioned}</span>
                </div>
                <h4 className="text-sm font-bold text-slate-900">{art.title}</h4>
              </div>
              <button
                onClick={() => onEscalateVoice(art)}
                className="px-3.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold cursor-pointer shadow-2xs"
              >
                Escalate Call
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// 7. 404 Route
function NotFoundRoute() {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-12 text-center shadow-2xs space-y-3">
      <Compass className="w-10 h-10 text-slate-400 mx-auto" />
      <h3 className="text-lg font-bold text-slate-900">Page Not Found</h3>
      <p className="text-xs text-slate-500">The requested intelligence route does not exist.</p>
    </div>
  );
}

export default function App() {
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeVoiceCallArticle, setActiveVoiceCallArticle] = useState<Article | null>(null);
  const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);

  return (
    <WarRoomProvider>
      <BrowserRouter>
        <Routes>
          <Route
            element={
              <AppShell
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                selectedArticle={selectedArticle}
                setSelectedArticle={setSelectedArticle}
                activeVoiceCallArticle={activeVoiceCallArticle}
                setActiveVoiceCallArticle={setActiveVoiceCallArticle}
              />
            }
          >
            {/* 1. Dashboard */}
            <Route path="/" element={<DashboardRoute />} />
            <Route path="/dashboard" element={<DashboardRoute />} />

            {/* 2. Crisis War Room */}
            <Route path="/crisis-war-room" element={<CrisisWarRoomRoute />} />
            <Route path="/dashboard/crisis-war-room" element={<CrisisWarRoomRoute />} />

            {/* 3. Manual Intel Upload */}
            <Route path="/manual-upload" element={<ManualUploadRoute />} />
            <Route path="/dashboard/manual-upload" element={<ManualUploadRoute />} />

            {/* 4. Competitor Radar */}
            <Route path="/competitor-radar" element={<CompetitorRadarRoute />} />
            <Route path="/dashboard/competitor-radar" element={<CompetitorRadarRoute />} />

            {/* 4. SLA Proof Engine */}
            <Route path="/sla-proof-engine" element={<SlaProofEngineRoute />} />
            <Route path="/dashboard/sla-proof-engine" element={<SlaProofEngineRoute />} />

            {/* 5. Analysis */}
            <Route path="/analysis" element={<AnalysisRoute />} />
            <Route path="/dashboard/analysis" element={<AnalysisRoute />} />

            {/* 6. Reports */}
            <Route path="/reports" element={<ReportsRoute />} />
            <Route path="/dashboard/reports" element={<ReportsRoute />} />

            {/* 7. News Feed */}
            <Route path="/news" element={<NewsFeedRoute />} />
            <Route path="/dashboard/news" element={<NewsFeedRoute />} />

            {/* 8. Sources */}
            <Route path="/sources" element={<SourcesRoute />} />
            <Route path="/dashboard/sources" element={<SourcesRoute />} />

            {/* 9. Alerts */}
            <Route path="/alerts" element={<AlertsRoute />} />
            <Route path="/dashboard/alerts" element={<AlertsRoute />} />

            {/* Clean Redirects for any legacy Settings route */}
            <Route path="/settings" element={<Navigate to="/" replace />} />
            <Route path="/dashboard/settings" element={<Navigate to="/" replace />} />

            {/* Fallback Catch-All */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </WarRoomProvider>
  );
}
