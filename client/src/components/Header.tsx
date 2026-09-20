import React, { useState, useEffect } from 'react';
import { Search, Sun, RefreshCw, Radio, Globe } from 'lucide-react';
import { GoogleSearchModal } from './GoogleSearchModal';

interface HeaderProps {
  onFetchLiveNews?: () => void;
  onSimulateCrisis?: () => void;
  isFetchingLive?: boolean;
  isSimulating?: boolean;
  instagramCooldownSec?: number;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

export const Header: React.FC<HeaderProps> = ({
  onFetchLiveNews,
  onSimulateCrisis,
  isFetchingLive,
  isSimulating,
  instagramCooldownSec = 0,
  searchQuery,
  onSearchChange
}) => {
  const [currentDateTime, setCurrentDateTime] = useState({
    date: 'Sep 18, 2026',
    time: '10:24 AM'
  });

  const [isGoogleCseOpen, setIsGoogleCseOpen] = useState(false);
  const isLoading = Boolean(isFetchingLive ?? isSimulating);
  const handleFetch = onFetchLiveNews || onSimulateCrisis;

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
      const timeStr = now.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
      setCurrentDateTime({ date: dateStr, time: timeStr });
    };

    updateTime();
    const interval = setInterval(updateTime, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="bg-[#F6F7F9] border-b border-slate-200/60 shrink-0 px-4 py-3 md:py-0 md:h-16 md:px-6 flex flex-col md:flex-row md:items-center justify-between gap-2.5 md:gap-4">
      {/* Mobile Top Row: Brand & Fetch Live Button (< 768px ONLY) */}
      <div className="flex md:hidden items-center justify-between gap-3 w-full">
        {/* Brand Logo & Title */}
        <div className="flex items-center gap-2 overflow-hidden">
          <div className="w-7 h-7 rounded-full border-2 border-rose-600 flex items-center justify-center shrink-0">
            <div className="w-3 h-3 rounded-full bg-rose-600" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="font-bold text-slate-900 tracking-tight text-sm font-sans">
              VEE-ALERT
            </span>
            <span className="text-[9px] font-medium text-slate-500 tracking-wide">
              Intelligence Platform
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsGoogleCseOpen(true)}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded-lg text-xs font-semibold"
            title="Google Programmable Search Engine"
          >
            <Globe className="w-3.5 h-3.5" />
            <span>CSE</span>
          </button>

          {/* Compact Mobile Fetch Live News Button */}
          <div className="flex items-center gap-1.5">
            {instagramCooldownSec > 0 && (
              <span
                className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded flex items-center gap-1 shrink-0"
                title={`Instagram rate-limit cooldown: ${instagramCooldownSec}s`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                {instagramCooldownSec}s
              </span>
            )}
            <button
              onClick={handleFetch}
              disabled={isLoading}
              title={
                instagramCooldownSec > 0
                  ? `Fetch Live News (9 sources active | Instagram on cooldown for ${instagramCooldownSec}s)`
                  : "Scrape and triage authentic real-world news right now"
              }
              className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white rounded-lg text-xs font-semibold shadow-xs transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shrink-0"
            >
              {isLoading ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Fetching...</span>
                </>
              ) : (
                <>
                  <Radio className="w-3.5 h-3.5" />
                  <span>Fetch Live</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Global Search Bar (Full width on mobile, max-w-xl on desktop) */}
      <div className="w-full md:flex-1 md:max-w-xl">
        <div className="relative flex items-center">
          <Search className="absolute left-3 w-4 h-4 text-slate-400 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search events, companies, sources, reports..."
            className="w-full h-9 md:h-10 pl-9 md:pl-10 pr-20 md:pr-24 bg-white border border-slate-200 rounded-lg text-xs md:text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500 transition-all shadow-xs"
          />
          <button
            onClick={() => setIsGoogleCseOpen(true)}
            className="absolute right-2 px-2 py-1 text-[11px] font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded flex items-center gap-1 transition-colors cursor-pointer"
            title="Search with Google Programmable Search Engine"
          >
            <Globe className="w-3 h-3" />
            <span className="hidden sm:inline">Google CSE</span>
          </button>
        </div>
      </div>

      {/* Desktop Right Actions (>= 768px ONLY - Exactly identical to previous desktop UI) */}
      <div className="hidden md:flex items-center gap-5 shrink-0">
        {/* Theme Toggle Icon (Sun) */}
        <button
          title="Light Mode Active"
          className="p-2 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-200/60 transition-colors cursor-pointer"
        >
          <Sun className="w-5 h-5 text-slate-600 hover:rotate-45 transition-transform duration-300" />
        </button>

        {/* Date & Time Display */}
        <div className="text-right leading-tight select-none">
          <div className="text-xs font-semibold text-slate-700">{currentDateTime.date}</div>
          <div className="text-[11px] text-slate-400">{currentDateTime.time}</div>
        </div>

        {/* Primary Action: Red Fetch Live News Button (100% authentic live scraping) */}
        <div className="flex items-center gap-2">
          {instagramCooldownSec > 0 && (
            <span
              className="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-lg flex items-center gap-1.5 shadow-2xs"
              title="Instagram Graph API rate-limit cooldown active. Other 9 sources continue scraping live."
            >
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              IG Cooldown: {instagramCooldownSec}s
            </span>
          )}
          <button
            onClick={handleFetch}
            disabled={isLoading}
            title={
              instagramCooldownSec > 0
                ? `Fetch Live News (9 sources active | Instagram on cooldown for ${instagramCooldownSec}s)`
                : "Scrape and triage authentic real-world news right now (all sources + Instagram)"
            }
            className="flex items-center gap-2 px-4 py-2 bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white rounded-lg text-sm font-semibold shadow-sm transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {isLoading ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>Fetching Live...</span>
              </>
            ) : (
              <>
                <Radio className="w-4 h-4" />
                <span>Fetch Live News</span>
              </>
            )}
          </button>
        </div>
      </div>

      <GoogleSearchModal
        isOpen={isGoogleCseOpen}
        onClose={() => setIsGoogleCseOpen(false)}
        initialQuery={searchQuery}
      />
    </header>
  );
};
