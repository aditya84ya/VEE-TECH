import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  AlertTriangle,
  Radio,
  ShieldCheck,
  TrendingUp,
  FileText,
  Newspaper,
  Database,
  Bell,
  ScanText
} from 'lucide-react';

interface SidebarProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  isRealtimeActive: boolean;
  criticalCount: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  isCollapsed,
  onToggleCollapse,
  isRealtimeActive,
  criticalCount
}) => {
  const navSections = [
    {
      title: 'COMMAND CENTER',
      items: [
        { path: '/', label: 'Dashboard', icon: LayoutDashboard },
        { path: '/crisis-war-room', label: 'Crisis War Room', icon: AlertTriangle },
        { path: '/manual-upload', label: 'Manual Intel Upload', icon: ScanText },
        { path: '/competitor-radar', label: 'Competitor Radar', icon: Radio },
        { path: '/sla-proof-engine', label: 'SLA Proof Engine', icon: ShieldCheck }
      ]
    },
    {
      title: 'ANALYTICS',
      items: [
        { path: '/analysis', label: 'Analysis', icon: TrendingUp },
        { path: '/reports', label: 'Reports', icon: FileText }
      ]
    },
    {
      title: 'INTELLIGENCE',
      items: [
        { path: '/news', label: 'News Feed', icon: Newspaper },
        { path: '/sources', label: 'Sources', icon: Database },
        { path: '/alerts', label: 'Alerts', icon: Bell, hasBadge: criticalCount > 0 }
      ]
    }
  ];

  return (
    <aside
      className={`fixed top-0 left-0 h-screen bg-slate-950 text-white border-r border-slate-800 z-40 transition-all duration-200 hidden md:flex flex-col select-none ${
        isCollapsed ? 'w-[72px]' : 'w-64'
      }`}
    >
      {/* Black Rectangular Collapse Toggle on Right Edge */}
      <button
        onClick={onToggleCollapse}
        title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="absolute top-5 -right-6 z-50 flex items-center justify-center w-6 h-6 bg-slate-900 border border-slate-700 text-white rounded-r font-mono text-[10px] font-bold tracking-tighter shadow-md hover:bg-slate-800 transition-colors cursor-pointer"
      >
        {isCollapsed ? '<<' : '>>'}
      </button>

      {/* Brand Header */}
      <div className="h-16 flex items-center px-4 border-b border-slate-800/80 shrink-0">
        <div className="flex items-center gap-2.5 overflow-hidden">
          {/* Circular Red Target Logo */}
          <div className="w-8 h-8 rounded-full border-2 border-rose-600 flex items-center justify-center shrink-0">
            <div className="w-3.5 h-3.5 rounded-full bg-rose-600" />
          </div>

          {!isCollapsed && (
            <div className="flex flex-col leading-tight whitespace-nowrap">
              <span className="font-bold text-white tracking-tight text-base font-sans">
                VEE-ALERT
              </span>
              <span className="text-[10px] font-medium text-slate-400 tracking-wide">
                Intelligence Platform
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Navigation Sections with react-router-dom NavLink */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5 scrollbar-thin">
        {navSections.map((section) => (
          <div key={section.title} className="space-y-1">
            {!isCollapsed && (
              <h4 className="px-3 text-[11px] font-bold text-slate-400 tracking-wider uppercase">
                {section.title}
              </h4>
            )}
            {section.items.map((item) => {
              const Icon = item.icon;

              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/'}
                  title={isCollapsed ? item.label : undefined}
                  className={({ isActive }) =>
                    `w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all duration-150 group ${
                      isActive
                        ? 'bg-rose-500/15 text-rose-500 font-semibold border-l-4 border-rose-600 shadow-xs'
                        : 'text-slate-300 hover:bg-slate-900 hover:text-white font-medium'
                    } ${isCollapsed ? 'justify-center px-2' : ''}`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon
                        className={`w-4 h-4 shrink-0 transition-colors ${
                          isActive ? 'text-rose-500' : 'text-slate-400 group-hover:text-slate-200'
                        }`}
                      />
                      {!isCollapsed && (
                        <span className="flex-1 text-left truncate">{item.label}</span>
                      )}
                      {!isCollapsed && item.hasBadge && (
                        <span className="w-2 h-2 rounded-full bg-rose-600 shrink-0" />
                      )}
                    </>
                  )}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Bottom Status Card */}
      <div className="p-3 border-t border-slate-800/80 shrink-0">
        <div
          className={`flex items-center gap-2.5 p-2.5 rounded-xl border border-slate-800 bg-slate-900/80 ${
            isCollapsed ? 'justify-center' : ''
          }`}
        >
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span
              className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                isRealtimeActive ? 'bg-emerald-400' : 'bg-amber-400'
              }`}
            />
            <span
              className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                isRealtimeActive ? 'bg-emerald-500' : 'bg-amber-500'
              }`}
            />
          </span>

          {!isCollapsed && (
            <div className="leading-tight overflow-hidden">
              <div className="text-xs font-bold text-white truncate">System Online</div>
              <div className="text-[10px] text-slate-400 truncate">Supabase Live</div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};
