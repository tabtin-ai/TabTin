import type { ReactNode, SVGProps } from 'react'

export type IconProps = SVGProps<SVGSVGElement>

const baseProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  strokeWidth: 1.8,
  viewBox: '0 0 24 24',
  width: '1em',
  height: '1em',
}

const StrokeIcon = ({
  className,
  children,
  ...props
}: IconProps & { children: ReactNode }) => (
  <svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className={className} {...baseProps} {...props}>
    {children}
  </svg>
)

export const AlertCircle = (props: IconProps) => (
  <StrokeIcon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 8v5" />
    <circle cx="12" cy="16.5" r="0.9" fill="currentColor" stroke="none" />
  </StrokeIcon>
)

export const RefreshCcw = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M7.5 7.5A6.5 6.5 0 1 1 5.8 14" />
    <path d="M7.5 4.5v3h-3" />
  </StrokeIcon>
)

export const X = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="m6 6 12 12" />
    <path d="m18 6-12 12" />
  </StrokeIcon>
)

export const CloseIcon = X

export const Plus = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </StrokeIcon>
)

export const Check = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M5 12.5 9.5 17 19 7.5" />
  </StrokeIcon>
)

export const Download = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M12 4v10" />
    <path d="m8 10 4 4 4-4" />
    <path d="M5 18h14" />
  </StrokeIcon>
)

export const File = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M8 3.5h6l4 4V20a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
    <path d="M14 3.5V8h4" />
  </StrokeIcon>
)

export const Trash2 = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M4 7h16" />
    <path d="M9 3.5h6" />
    <path d="M7.5 7l.7 11a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9l.7-11" />
    <path d="M10 10v5.5" />
    <path d="M14 10v5.5" />
  </StrokeIcon>
)

export const Edit = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="m14.5 5.5 4 4" />
    <path d="M6 18.5 7 14l8.8-8.8a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L10 17l-4 .9Z" />
  </StrokeIcon>
)

export const EyeOff = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M3.5 3.5 20.5 20.5" />
    <path d="M10.3 6.2A9.6 9.6 0 0 1 12 6c4.9 0 8.6 4.4 9.6 6-.6.9-2 2.8-4.1 4.4" />
    <path d="M8.8 8.7A4.2 4.2 0 0 0 8 11a4 4 0 0 0 6.4 3.2" />
    <path d="M6.1 15.9C4.2 14.3 3 12.6 2.4 12c.7-1 2.2-3 4.4-4.6" />
  </StrokeIcon>
)

export const ArrowLeft = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M18 12H6" />
    <path d="m10.5 7.5-4.5 4.5 4.5 4.5" />
  </StrokeIcon>
)

export const ArrowRight = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M6 12h12" />
    <path d="m13.5 7.5 4.5 4.5-4.5 4.5" />
  </StrokeIcon>
)

export const ArrowUp = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M12 18V6" />
    <path d="m7.5 10.5 4.5-4.5 4.5 4.5" />
  </StrokeIcon>
)

export const ArrowDown = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M12 6v12" />
    <path d="m7.5 13.5 4.5 4.5 4.5-4.5" />
  </StrokeIcon>
)

export const ArrowUpDown = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M12 4.5v15" />
    <path d="m8.5 8 3.5-3.5L15.5 8" />
    <path d="m8.5 16 3.5 3.5 3.5-3.5" />
  </StrokeIcon>
)

export const Copy = (props: IconProps) => (
  <StrokeIcon {...props}>
    <rect x="8" y="8" width="10" height="11" rx="1.5" />
    <path d="M6 15H5a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 5 4h8A1.5 1.5 0 0 1 14.5 5.5V6" />
  </StrokeIcon>
)

export const Filter = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M4 6h16l-6.5 7v4.5l-3 1.5V13L4 6Z" />
  </StrokeIcon>
)

export const FreezeColumn = (props: IconProps) => (
  <StrokeIcon {...props}>
    <rect x="4" y="5" width="16" height="14" rx="1.5" />
    <path d="M9 5v14" />
    <path d="M4 9h5" />
    <path d="M4 13h5" />
  </StrokeIcon>
)

export const LayoutList = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M7 7h11" />
    <path d="M7 12h11" />
    <path d="M7 17h11" />
    <circle cx="4.5" cy="7" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="17" r="0.8" fill="currentColor" stroke="none" />
  </StrokeIcon>
)

export const History = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M4.5 12A7.5 7.5 0 1 0 7 6.4" />
    <path d="M4.5 4.5v4h4" />
    <path d="M12 8v4l3 2" />
  </StrokeIcon>
)

export const ListOrdered = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M9 7h10" />
    <path d="M9 12h10" />
    <path d="M9 17h10" />
    <path d="M4 7h1.5v3" />
    <path d="M3.8 12.2a1.4 1.4 0 0 1 1.2-.7 1.3 1.3 0 0 1 1.3 1.3c0 .5-.3 1-.7 1.2l-1.8 1.5h2.5" />
    <path d="M4 16.2h1.5a1 1 0 1 1 0 2H4.1" />
  </StrokeIcon>
)

export const MessageSquare = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M6 6.5h12a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 18 16.5H11l-4.5 3v-3H6A1.5 1.5 0 0 1 4.5 15V8A1.5 1.5 0 0 1 6 6.5Z" />
  </StrokeIcon>
)

export const MagicAi = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M12 4.5 13.8 9l4.7 1.8-4.7 1.7L12 17l-1.8-4.5-4.7-1.7L10.2 9 12 4.5Z" />
    <path d="M18.5 4.5v2" />
    <path d="M17.5 5.5h2" />
    <path d="M5.5 16.5v3" />
    <path d="M4 18h3" />
  </StrokeIcon>
)

export const Square = (props: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" fill="currentColor" width="1em" height="1em" viewBox="0 0 24 24" {...props}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </svg>
)

export const DraggableHandle = (props: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" fill="currentColor" width="1em" height="1em" viewBox="0 0 24 24" {...props}>
    <circle cx="8" cy="7" r="1.4" />
    <circle cx="8" cy="12" r="1.4" />
    <circle cx="8" cy="17" r="1.4" />
    <circle cx="16" cy="7" r="1.4" />
    <circle cx="16" cy="12" r="1.4" />
    <circle cx="16" cy="17" r="1.4" />
  </svg>
)

export const Maximize2 = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M15 4.5h4.5V9" />
    <path d="m19.5 4.5-6 6" />
    <path d="M9 19.5H4.5V15" />
    <path d="m4.5 19.5 6-6" />
  </StrokeIcon>
)

export const ChevronDown = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="m6 9 6 6 6-6" />
  </StrokeIcon>
)

export const ChevronRight = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="m9 6 6 6-6 6" />
  </StrokeIcon>
)

export const Lock = (props: IconProps) => (
  <StrokeIcon {...props}>
    <rect x="6.5" y="11" width="11" height="8" rx="1.5" />
    <path d="M9 11V8.5a3 3 0 1 1 6 0V11" />
  </StrokeIcon>
)

export const A = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M6.5 18 12 6l5.5 12" />
    <path d="M9 13h6" />
  </StrokeIcon>
)

export const Calendar = (props: IconProps) => (
  <StrokeIcon {...props}>
    <rect x="4.5" y="6" width="15" height="13.5" rx="1.5" />
    <path d="M8 4.5v3" />
    <path d="M16 4.5v3" />
    <path d="M4.5 10h15" />
  </StrokeIcon>
)

export const CheckCircle2 = (props: IconProps) => (
  <StrokeIcon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.5 12.3 11 14.8 15.8 9.8" />
  </StrokeIcon>
)

export const CheckSquare = (props: IconProps) => (
  <StrokeIcon {...props}>
    <rect x="5" y="5" width="14" height="14" rx="2" />
    <path d="M8.5 12.3 11 14.8 15.8 9.8" />
  </StrokeIcon>
)

export const Clock4 = (props: IconProps) => (
  <StrokeIcon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 8v4l3.5 2" />
  </StrokeIcon>
)

export const Code = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="m9 7-4 5 4 5" />
    <path d="m15 7 4 5-4 5" />
    <path d="m13.5 5.5-3 13" />
  </StrokeIcon>
)

export const DollarSign = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M12 4.5v15" />
    <path d="M15.5 7.5c0-1.4-1.6-2.5-3.5-2.5s-3.5 1.1-3.5 2.5 1.3 2.2 3.5 2.7 3.5 1.3 3.5 3-1.6 2.8-3.5 2.8-3.5-1.1-3.5-2.5" />
  </StrokeIcon>
)

export const Hash = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M9 5 7 19" />
    <path d="M17 5 15 19" />
    <path d="M5 9h14" />
    <path d="M4 15h14" />
  </StrokeIcon>
)

export const Layers = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="m12 5 7 3.5-7 3.5-7-3.5L12 5Z" />
    <path d="m5 12 7 3.5 7-3.5" />
    <path d="m5 15.5 7 3.5 7-3.5" />
  </StrokeIcon>
)

export const Link = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M10 13.5 14 9.5" />
    <path d="M8 15.5H6.5a3 3 0 1 1 0-6H9" />
    <path d="M15 8.5h2.5a3 3 0 1 1 0 6H15" />
  </StrokeIcon>
)

export const ListChecks = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M10 7h9" />
    <path d="M10 12h9" />
    <path d="M10 17h9" />
    <path d="m4.5 7 1.5 1.5L8.5 6" />
    <path d="m4.5 12 1.5 1.5 2.5-2.5" />
    <path d="m4.5 17 1.5 1.5 2.5-2.5" />
  </StrokeIcon>
)

export const LongText = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M5 7h14" />
    <path d="M5 11h10" />
    <path d="M5 15h14" />
    <path d="M5 19h8" />
  </StrokeIcon>
)

export const Mail = (props: IconProps) => (
  <StrokeIcon {...props}>
    <rect x="4.5" y="6.5" width="15" height="11" rx="1.5" />
    <path d="m5.5 8 6.5 5 6.5-5" />
  </StrokeIcon>
)

export const Play = (props: IconProps) => (
  <svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" fill="currentColor" width="1em" height="1em" viewBox="0 0 24 24" {...props}>
    <path d="M8 6.5v11l9-5.5-9-5.5Z" />
  </svg>
)

export const Percent = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M7 17 17 7" />
    <circle cx="7.5" cy="7.5" r="2" />
    <circle cx="16.5" cy="16.5" r="2" />
  </StrokeIcon>
)

export const Phone = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M7.5 5.5h2L11 9l-1.5 1.5a12.5 12.5 0 0 0 4 4L15 13l3.5 1.5v2a1.5 1.5 0 0 1-1.7 1.5C10.8 17.1 6.9 13.2 6 8.2A1.5 1.5 0 0 1 7.5 6.5Z" />
  </StrokeIcon>
)

export const Search = (props: IconProps) => (
  <StrokeIcon {...props}>
    <circle cx="10.5" cy="10.5" r="5.5" />
    <path d="m15 15 4 4" />
  </StrokeIcon>
)

export const Star = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="m12 5 2.1 4.2 4.7.7-3.4 3.3.8 4.8-4.2-2.2-4.2 2.2.8-4.8-3.4-3.3 4.7-.7L12 5Z" />
  </StrokeIcon>
)

export const User = (props: IconProps) => (
  <StrokeIcon {...props}>
    <circle cx="12" cy="9" r="3.2" />
    <path d="M6.5 18.5a5.5 5.5 0 0 1 11 0" />
  </StrokeIcon>
)

export const Image = (props: IconProps) => (
  <StrokeIcon {...props}>
    <rect x="4.5" y="6" width="15" height="12.5" rx="1.5" />
    <circle cx="9" cy="10" r="1.3" />
    <path d="m6.5 16 3.5-3.5 2.5 2.5 2-2 3 3" />
  </StrokeIcon>
)
