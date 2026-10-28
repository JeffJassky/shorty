/* Icons — minimal stroke style, currentColor */
import type { ReactNode, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number; className?: string }

const I = (paths: ReactNode, viewBox = '0 0 24 24') =>
  ({ size = 16, className = 'icon', ...p }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...p}
    >
      {paths}
    </svg>
  )

export const Icons = {
  Search: I(<><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></>),
  Plus: I(<><path d="M12 5v14" /><path d="M5 12h14" /></>),
  Sun: I(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>),
  Moon: I(<><path d="M20 14.5A8 8 0 1110.5 4a6 6 0 009.5 10.5z" /></>),
  Chevron: I(<><path d="M9 6l6 6-6 6" /></>),
  ChevronDown: I(<><path d="M6 9l6 6 6-6" /></>),
  Clock: I(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>),
  Tag: I(<><path d="M3 12l8-8h8v8l-8 8z" /><circle cx="14.5" cy="9.5" r="1.2" /></>),
  Download: I(<><path d="M12 4v12" /><path d="M7 11l5 5 5-5" /><path d="M4 20h16" /></>),
  Eye: I(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>),
  Edit: I(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 113 3L7 19l-4 1 1-4z" /></>),
  Copy: I(<><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V4a2 2 0 00-2-2H4a2 2 0 00-2 2v10a2 2 0 002 2h4" /></>),
  Dots: I(<><circle cx="6" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="18" cy="12" r="1.5" /></>),
  Settings: I(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></>),
  Help: I(<><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 015 0c0 1.5-2.5 2-2.5 3.5" /><circle cx="12" cy="17" r="0.6" fill="currentColor" /></>),
  Check: I(<><path d="M4 12l5 5 11-11" /></>),
  X: I(<><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>),
  Calendar: I(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18" /><path d="M8 3v4M16 3v4" /></>),
  Warn: I(<><path d="M12 3l10 18H2z" /><path d="M12 10v5" /><circle cx="12" cy="18" r="0.6" fill="currentColor" /></>),
  ArrowRight: I(<><path d="M4 12h16" /><path d="M14 6l6 6-6 6" /></>),
  Refresh: I(<><path d="M20 11a8 8 0 00-14.5-4.2L4 9" /><path d="M4 4v5h5" /><path d="M4 13a8 8 0 0014.5 4.2L20 15" /><path d="M20 20v-5h-5" /></>),
  Lock: I(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></>),
  CheckCircle: I(<><circle cx="12" cy="12" r="8.5" /><path d="M8 12.5l2.8 2.8L16 10" /></>),
  Link: I(<><path d="M10 14a4.5 4.5 0 006.4 0l3-3a4.5 4.5 0 00-6.4-6.4l-1 1" /><path d="M14 10a4.5 4.5 0 00-6.4 0l-3 3a4.5 4.5 0 006.4 6.4l1-1" /></>),
  ExternalLink: I(<><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" /></>),
  Grip: I(<><circle cx="9" cy="6" r="1.3" /><circle cx="15" cy="6" r="1.3" /><circle cx="9" cy="12" r="1.3" /><circle cx="15" cy="12" r="1.3" /><circle cx="9" cy="18" r="1.3" /><circle cx="15" cy="18" r="1.3" /></>),
  Trash: I(<><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v6M14 11v6" /></>),
  Info: I(<><circle cx="12" cy="12" r="9" /><path d="M12 11v6" /><circle cx="12" cy="7.5" r="0.7" fill="currentColor" /></>),
  QrCode: I(<><rect x="3.5" y="3.5" width="6" height="6" rx="1" /><rect x="14.5" y="3.5" width="6" height="6" rx="1" /><rect x="3.5" y="14.5" width="6" height="6" rx="1" /><path d="M14.5 14.5h2.5v2.5h-2.5zM19 14.5v2M14.5 19.5h6" /></>),
  Archive: I(<><rect x="3" y="4" width="18" height="4.5" rx="1" /><path d="M5 8.5V19a1 1 0 001 1h12a1 1 0 001-1V8.5" /><path d="M10 13h4" /></>),
  Globe: I(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" /></>),
  Warning: I(<><path d="M12 3l10 18H2z" /><path d="M12 10v5" /><circle cx="12" cy="18" r="0.6" fill="currentColor" /></>),
  Up: I(<><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></>),
  Down: I(<><path d="M12 5v14" /><path d="M6 13l6 6 6-6" /></>),
}
