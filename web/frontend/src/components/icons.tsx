// 轻量线性图标（Lucide 风格，MIT 路径），stroke=currentColor，自适应色。
// 用来替换廉价的 emoji 图标，参考 ChatGPT / Stepfun 的简洁线性风格。
import type { CSSProperties } from 'react';
interface P { size?: number; className?: string; strokeWidth?: number; style?: CSSProperties; 'aria-hidden'?: boolean; }

const svg = (size = 18, sw = 1.8) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: sw,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
});

export const IconChat = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);
export const IconAgentOffice = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="M3 8v9l9 5 9-5V8M12 13v9" />
    <path d="m7.5 5.5 9 5" />
  </svg>
);
export const IconSkills = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="m12 3-1.6 4.9a2 2 0 0 1-1.3 1.3L4.2 10.8l4.9 1.6a2 2 0 0 1 1.3 1.3L12 18.6l1.6-4.9a2 2 0 0 1 1.3-1.3l4.9-1.6-4.9-1.6a2 2 0 0 1-1.3-1.3z" />
  </svg>
);
export const IconOutputs = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
  </svg>
);
export const IconAccounts = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m10.7 12.3 9.3-9.3" /><path d="m17 5 3 3" /><path d="m15 7 3 3" />
  </svg>
);
export const IconProfile = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
  </svg>
);
export const IconNewChat = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z" />
  </svg>
);
export const IconArrowUp = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
);
export const IconStop = ({ size, className }: P) => (
  <svg {...svg(size)} className={className} fill="currentColor" stroke="none">
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
  </svg>
);
export const IconCopy = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
export const IconCheck = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}><path d="M20 6 9 17l-5-5" /></svg>
);
export const IconEdit = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
export const IconRetry = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />
  </svg>
);
export const IconArchive = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <rect x="2" y="3" width="20" height="5" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" />
  </svg>
);
export const IconUnarchive = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <rect x="2" y="3" width="20" height="5" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M12 18v-6" /><path d="m9 15 3-3 3 3" />
  </svg>
);
export const IconTrash = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);
export const IconPlus = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}><path d="M5 12h14" /><path d="M12 5v14" /></svg>
);
export const IconChevron = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}><path d="m9 18 6-6-6-6" /></svg>
);

// ---- 分类图标（SKILL 卡 / Outputs 文件）----
export const IconVideo = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <rect x="2" y="4" width="20" height="16" rx="2.5" /><path d="M2 9h20M7 4v5M17 4v5" />
    <path d="m10.5 12.5 3.5 2-3.5 2z" fill="currentColor" stroke="none" />
  </svg>
);
export const IconImage = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <rect x="3" y="3" width="18" height="18" rx="2.5" /><circle cx="9" cy="9" r="1.8" />
    <path d="m21 15-3.6-3.6a2 2 0 0 0-2.8 0L6 20" />
  </svg>
);
export const IconMusic = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
  </svg>
);
export const IconMic = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><path d="M12 19v3" />
  </svg>
);
export const IconText = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M4 7V5h16v2" /><path d="M9 20h6" /><path d="M12 5v15" />
  </svg>
);
export const IconChart = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M3 3v18h18" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" />
  </svg>
);
export const IconHistory = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M3 12a9 9 0 1 0 2.64-6.36L3 8" /><path d="M3 3v5h5" />
    <path d="M12 7v5l3 2" />
  </svg>
);
export const IconSend = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" />
  </svg>
);
export const IconSearch = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
  </svg>
);
export const IconCompass = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <circle cx="12" cy="12" r="10" /><path d="m16.2 7.8-2.1 6.4-6.4 2.1 2.1-6.4z" />
  </svg>
);
export const IconLayout = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <rect x="3" y="3" width="18" height="18" rx="2.5" /><path d="M3 9h18M9 21V9" />
  </svg>
);
export const IconLayers = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="m12 2 9 5-9 5-9-5z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" />
  </svg>
);
export const IconFile = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v5h5" />
  </svg>
);
export const IconRefresh = IconRetry;

export const IconFolder = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z" />
  </svg>
);

export const IconDashboard = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" />
  </svg>
);
export const IconFire = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
  </svg>
);
export const IconCalendar = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M3 10h18M8 2v4M16 2v4" />
  </svg>
);
export const IconIdea = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M9 18h6" /><path d="M10 22h4" />
    <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5" />
  </svg>
);
export const IconBookmark = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
);
export const IconPublish = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="m3 11 18-5v12L3 14v-3z" /><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
  </svg>
);
export const IconUserRound = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
  </svg>
);
export const IconUserPlus = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <circle cx="10" cy="8" r="4" /><path d="M2 21a8 8 0 0 1 16 0" /><path d="M19 8v6" /><path d="M22 11h-6" />
  </svg>
);
export const IconInfo = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
  </svg>
);
export const IconSpark = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" />
  </svg>
);
export const IconKey = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.3-9.3" /><path d="m17 5 3 3" /><path d="m15 7 3 3" />
  </svg>
);
export const IconEye = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />
  </svg>
);
export const IconEyeOff = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M10.7 5.1A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.1 4" />
    <path d="M6.6 6.6A17.6 17.6 0 0 0 2 12s3.5 7 10 7c1.9 0 3.5-.5 4.9-1.3" />
    <path d="m2 2 20 20" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </svg>
);
export const IconPin = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M12 17v5" /><path d="M9 4h6l-1 7 3 3H7l3-3-1-7Z" />
  </svg>
);
export const IconClock = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <circle cx="12" cy="12" r="10" /><path d="M12 7v5l3 2" />
  </svg>
);
export const IconCoins = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <circle cx="8" cy="8" r="6" /><path d="M18.09 10.37A6 6 0 1 1 10.34 18" />
    <path d="M7 6h1v4" /><path d="m16.7 13.7.8.8" />
  </svg>
);
export const IconSettings2 = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M12 3a9 9 0 0 1 9 9 9 9 0 0 1-9 9 9 9 0 0 1-9-9 9 9 0 0 1 9-9Z" />
    <path d="M15.4 8.6 8.6 15.4" /><path d="M8.6 8.6l6.8 6.8" />
  </svg>
);
export const IconDownload = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M4 21h16" />
  </svg>
);
export const IconWarn = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4" /><path d="M12 17h.01" />
  </svg>
);
export const IconPlay = ({ size, className, strokeWidth }: P) => (
  <svg {...svg(size, strokeWidth)} className={className} fill="currentColor" stroke="none">
    <path d="M6 4.8v14.4c0 .8.9 1.3 1.6.9l11.2-7.2c.6-.4.6-1.4 0-1.8L7.6 3.9c-.7-.4-1.6.1-1.6.9Z" />
  </svg>
);
