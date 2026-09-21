import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ArrowUp } from 'lucide-react';

export interface ScrollToTopButtonProps {
  /** Optional container ref to listen to and scroll. If omitted, auto-detects scrollable ancestor or falls back to window. */
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
  /** Scroll distance threshold in pixels before the button appears. Defaults to 300. */
  threshold?: number;
  /** Extra CSS classes if needed. */
  className?: string;
}

/**
 * Floating Scroll-To-Top Button
 * - Hidden at top of page, smoothly fades/slides in when scrolled past threshold (~300px).
 * - Fixed at bottom-right (bottom-4 right-4 on mobile, bottom-6 right-6 on desktop).
 * - Smoothly scrolls to top (instant if prefers-reduced-motion is active).
 * - Matches dark styling of executive action buttons (bg-slate-900 / hover:bg-slate-800).
 */
export const ScrollToTopButton: React.FC<ScrollToTopButtonProps> = ({
  scrollContainerRef,
  threshold = 300,
  className = ''
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Determine the active scrolling element:
  // 1. Explicit scrollContainerRef if supplied
  // 2. Nearest scrollable ancestor (overflow-y: auto/scroll with scrollable content)
  // 3. Fallback: window
  const getScrollContainer = useCallback((): HTMLElement | Window => {
    if (scrollContainerRef?.current) {
      return scrollContainerRef.current;
    }

    if (buttonRef.current && typeof window !== 'undefined') {
      let parent = buttonRef.current.parentElement;
      while (parent && parent !== document.body && parent !== document.documentElement) {
        const style = window.getComputedStyle(parent);
        const overflowY = style.overflowY;
        if (
          (overflowY === 'auto' || overflowY === 'scroll') &&
          parent.scrollHeight > parent.clientHeight
        ) {
          return parent;
        }
        parent = parent.parentElement;
      }
    }

    return typeof window !== 'undefined' ? window : (null as any);
  }, [scrollContainerRef]);

  useEffect(() => {
    const container = getScrollContainer();
    if (!container) return;

    const handleScroll = () => {
      let currentScroll = 0;
      if (container === window) {
        currentScroll =
          window.scrollY ||
          document.documentElement.scrollTop ||
          document.body.scrollTop ||
          0;
      } else if (container instanceof HTMLElement) {
        currentScroll = container.scrollTop;
      }
      setIsVisible(currentScroll > threshold);
    };

    // Initial check on mount
    handleScroll();

    // Attach passive listener for optimal scrolling performance
    container.addEventListener('scroll', handleScroll, { passive: true });

    // Also attach to window if container is an element, to handle any composite page scrolls
    if (container !== window) {
      window.addEventListener('scroll', handleScroll, { passive: true });
    }

    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (container !== window) {
        window.removeEventListener('scroll', handleScroll);
      }
    };
  }, [getScrollContainer, threshold]);

  const handleScrollToTop = () => {
    const container = getScrollContainer();
    if (!container) return;

    // Accessibility: Respect user's motion preferences
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior: ScrollBehavior = prefersReducedMotion ? 'auto' : 'smooth';

    if (container === window) {
      window.scrollTo({ top: 0, behavior });
      if (document.documentElement) {
        document.documentElement.scrollTo({ top: 0, behavior });
      }
      if (document.body) {
        document.body.scrollTo({ top: 0, behavior });
      }
    } else if (container instanceof HTMLElement) {
      container.scrollTo({ top: 0, behavior });
      // If window is also scrolled, reset it as well
      if (window.scrollY > 0) {
        window.scrollTo({ top: 0, behavior });
      }
    }
  };

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={handleScrollToTop}
      aria-label="Scroll to top"
      className={`fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-50 w-11 h-11 rounded-full bg-slate-900 hover:bg-slate-800 text-white shadow-md hover:shadow-lg active:scale-95 transition-all duration-300 ease-in-out flex items-center justify-center cursor-pointer focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2 ${
        isVisible
          ? 'opacity-100 translate-y-0 pointer-events-auto'
          : 'opacity-0 translate-y-4 pointer-events-none'
      } ${className}`}
    >
      <ArrowUp className="w-5 h-5 text-white" aria-hidden="true" />
    </button>
  );
};

export default ScrollToTopButton;
