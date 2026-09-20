import React from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { MobileBottomNav } from './MobileBottomNav';
import { VoiceCallModal } from './VoiceCallModal';
import { ArticleModal } from './ArticleModal';
import { useWarRoom, Article } from '../hooks/useWarRoom';

interface AppShellProps {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  selectedArticle: Article | null;
  setSelectedArticle: (art: Article | null) => void;
  activeVoiceCallArticle: Article | null;
  setActiveVoiceCallArticle: (art: Article | null) => void;
}

export const AppShell: React.FC<AppShellProps> = ({
  searchQuery,
  setSearchQuery,
  selectedArticle,
  setSelectedArticle,
  activeVoiceCallArticle,
  setActiveVoiceCallArticle
}) => {
  const [isCollapsed, setIsCollapsed] = React.useState<boolean>(false);
  const navigate = useNavigate();

  const {
    articles,
    loading,
    error,
    isRealtimeActive,
    isSimulating,
    isFetchingLive,
    acknowledgeArticle,
    fetchLiveNews,
    simulateCrisis
  } = useWarRoom();

  const criticalCount = articles.filter((a) => a.risk_level === 'Critical' || (a as any).severity === 'CRITICAL' || (Number(a.risk_score || (a as any).score) >= 9.0)).length;

  const handleEscalateVoice = (article: Article) => {
    setActiveVoiceCallArticle(article);
  };

  const handleCloseVoiceCall = () => {
    setActiveVoiceCallArticle(null);
  };

  return (
    <div className="min-h-screen bg-[#F6F7F9] text-slate-900 flex font-sans antialiased selection:bg-rose-500 selection:text-white">
      {/* 1. Global Left Sidebar (Dark Mode bg-slate-950) - Hidden on Mobile */}
      <Sidebar
        isCollapsed={isCollapsed}
        onToggleCollapse={() => setIsCollapsed(!isCollapsed)}
        isRealtimeActive={isRealtimeActive}
        criticalCount={criticalCount}
      />

      {/* 2. Main Content Canvas (ml-0 on mobile, md:ml-... on desktop) */}
      <div
        className={`flex-1 flex flex-col min-w-0 transition-all duration-200 ml-0 ${
          isCollapsed ? 'md:ml-[72px]' : 'md:ml-64'
        }`}
      >
        {/* Global Top Header */}
        <Header
          onFetchLiveNews={fetchLiveNews}
          onSimulateCrisis={simulateCrisis}
          isFetchingLive={isFetchingLive}
          isSimulating={isSimulating}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        />

        {/* Main Routed Content Area with Safe Bottom Padding for Mobile Nav */}
        <main className="flex-1 px-3 sm:px-6 md:px-8 py-4 sm:py-6 max-w-7xl w-full mx-auto pb-24 md:pb-6">
          {error && (
            <div className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-between text-xs text-amber-800 font-medium">
              <span>Notice: Local resilience failover active ({error})</span>
              <span className="text-emerald-700 font-semibold flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-500" /> System Protected
              </span>
            </div>
          )}

          {/* Render Active Route View Dynamically */}
          <Outlet
            context={{
              articles,
              loading,
              isRealtimeActive,
              searchQuery,
              onSelectArticle: (art: Article) => setSelectedArticle(art),
              onAcknowledge: acknowledgeArticle,
              onEscalateVoice: handleEscalateVoice,
              onNavigateToWarRoom: () => navigate('/crisis-war-room')
            }}
          />
        </main>
      </div>

      {/* 3. Mobile Fixed Bottom Navigation (< 768px ONLY) */}
      <MobileBottomNav criticalCount={criticalCount} />

      {/* Interactive Emergency Voice Call Escalation Modal */}
      {activeVoiceCallArticle && (
        <VoiceCallModal
          article={activeVoiceCallArticle}
          onClose={handleCloseVoiceCall}
          onAcknowledge={acknowledgeArticle}
        />
      )}

      {/* Intelligence Detail Briefing Modal */}
      {selectedArticle && (
        <ArticleModal
          article={selectedArticle}
          onClose={() => setSelectedArticle(null)}
          onAcknowledge={acknowledgeArticle}
          onEscalateVoice={handleEscalateVoice}
        />
      )}
    </div>
  );
};
