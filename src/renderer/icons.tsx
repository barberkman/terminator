// SVG icons ported from the design's buildIcons(). Stroke-based, 24x24 viewBox.

export type IconName =
  | 'plus'
  | 'bigplus'
  | 'close'
  | 'check'
  | 'lock'
  | 'unlock'
  | 'git'
  | 'power'
  | 'hammer'
  | 'play'
  | 'folder'
  | 'chevron'
  | 'columns'
  | 'single'
  | 'grid'
  | 'terminal'
  | 'sparkle'
  | 'note'
  | 'settings'
  | 'sidebar'

export function Icon({ name, size = 15 }: { name: IconName; size?: number }): React.JSX.Element {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    style: { display: 'block' },
  }
  switch (name) {
    case 'plus':
    case 'bigplus':
      return (
        <svg {...common}>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      )
    case 'close':
      return (
        <svg {...common}>
          <path d="M6 6l12 12" />
          <path d="M18 6L6 18" />
        </svg>
      )
    case 'check':
      return (
        <svg {...common}>
          <path d="M5 12l5 5L19 7" />
        </svg>
      )
    case 'lock':
      return (
        <svg {...common}>
          <rect x={5} y={11} width={14} height={9} rx={2} />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      )
    case 'unlock':
      return (
        <svg {...common}>
          <rect x={5} y={11} width={14} height={9} rx={2} />
          <path d="M8 11V7a4 4 0 0 1 7.5-1.3" />
        </svg>
      )
    case 'git':
      return (
        <svg {...common}>
          <circle cx={6} cy={6} r={2.4} />
          <circle cx={6} cy={18} r={2.4} />
          <circle cx={18} cy={9} r={2.4} />
          <path d="M18 11.4a6 6 0 0 1-6 6H6" />
          <path d="M6 8.4v7.2" />
        </svg>
      )
    case 'power':
      return (
        <svg {...common}>
          <path d="M12 4v8" />
          <path d="M7.5 7.5a7 7 0 1 0 9 0" />
        </svg>
      )
    case 'hammer':
      return (
        <svg {...common}>
          <path d="M14.5 5.5l4 4-2.5 2.5-4-4z" />
          <path d="M12 8L5 15a1.8 1.8 0 0 0 2.5 2.5L14.5 11" />
        </svg>
      )
    case 'play':
      return (
        <svg {...common}>
          <path d="M7 5l11 7-11 7z" />
        </svg>
      )
    case 'folder':
      return (
        <svg {...common}>
          <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      )
    case 'chevron':
      return (
        <svg {...common}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      )
    case 'columns':
      return (
        <svg {...common}>
          <rect x={4} y={5} width={16} height={14} rx={1.5} />
          <path d="M12 5v14" />
        </svg>
      )
    case 'single':
      return (
        <svg {...common}>
          <rect x={5} y={5} width={14} height={14} rx={1.5} />
        </svg>
      )
    case 'grid':
      return (
        <svg {...common}>
          <rect x={4} y={4} width={7} height={7} rx={1} />
          <rect x={13} y={4} width={7} height={7} rx={1} />
          <rect x={4} y={13} width={7} height={7} rx={1} />
          <rect x={13} y={13} width={7} height={7} rx={1} />
        </svg>
      )
    case 'terminal':
      return (
        <svg {...common}>
          <path d="M6 8l3.5 3.5L6 15" />
          <path d="M12.5 15H18" />
        </svg>
      )
    case 'sparkle':
      return (
        <svg {...common}>
          <path d="M12 4l1.7 5.1L19 11l-5.3 1.9L12 18l-1.7-5.1L5 11l5.3-1.9z" />
        </svg>
      )
    case 'note':
      return (
        <svg {...common}>
          <rect x={5} y={3.5} width={14} height={17} rx={2} />
          <path d="M9 8h6" />
          <path d="M9 12h6" />
          <path d="M9 16h4" />
        </svg>
      )
    case 'sidebar':
      return (
        <svg {...common}>
          <rect x={3} y={4} width={18} height={16} rx={2} />
          <path d="M9 4v16" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...common}>
          <circle cx={12} cy={12} r={3} />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      )
  }
}
