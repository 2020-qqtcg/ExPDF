import { forwardRef } from 'react'
import type { ReactNode } from 'react'
import type { LucideIcon, LucideProps } from 'lucide-react'

// One compact grid and stroke treatment keeps the reader's tools visually even.
function readerIcon(name: string, drawing: ReactNode): LucideIcon {
  const Icon = forwardRef<SVGSVGElement, LucideProps>(({ size = 20, color = 'currentColor', strokeWidth = 1.2, absoluteStrokeWidth, children, ...props }, ref) => <svg
    ref={ref} xmlns="http://www.w3.org/2000/svg" width={size} height={size}
    viewBox="0 0 24 24" fill="none" stroke={color}
    strokeWidth={absoluteStrokeWidth ? Number(strokeWidth) * 24 / Number(size) : strokeWidth}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden={props['aria-label'] ? undefined : true} data-reader-icon={name}
    {...props}
  >{drawing}{children}</svg>)
  Icon.displayName = `Reader${name}`
  return Icon
}

export const Home = readerIcon('Home', <g strokeWidth={1} transform="translate(0 1)"><path d="M6 19.5A2.5 2.5 0 0 1 3.5 17V9.8c0-.7.4-1.3 1.1-1.8l6.1-5a2 2 0 0 1 2.6 0l6.1 5c.7.5 1.1 1.1 1.1 1.8V17a2.5 2.5 0 0 1-2.5 2.5H6Z" /><path d="M9.5 19.5V14a2.5 2.5 0 0 1 5 0v5.5" /></g>)

export const Select = readerIcon('Select', <path d="M7 4.6a.5.5 0 0 0-.8.45l2.1 13.8a.5.5 0 0 0 .9.2l3-4.7 5.1-.5a.5.5 0 0 0 .25-.9L7 4.6Z" />)

export const Hand = readerIcon('Hand', <><path d="M8 11V5.4a1.5 1.5 0 0 1 3 0V10 3.9a1.5 1.5 0 0 1 3 0V10 5a1.5 1.5 0 0 1 3 0v6-3.8a1.5 1.5 0 0 1 3 0v6.1c0 4.3-2.8 7.2-6.6 7.2-2.7 0-4.5-1.4-6-3.5l-3-4.3c-1.2-1.8.7-3.5 2.1-2.1L9 13" /></>)

export const Highlight = readerIcon('Highlight', <><rect x="3.5" y="3.5" width="17" height="17" rx="1.6" /><path d="M6.6 6.6H9m-1.2 0v10.8m-1.2 0H9m6-10.8h2.4m-1.2 0v10.8m-1.2 0h2.4M7.8 12h8.4" /></>)

export const Underline = readerIcon('Underline', <><path d="M7.5 4.5V12a4.5 4.5 0 0 0 9 0V4.5M5 20h14" /></>)

export const Strikeout = readerIcon('Strikeout', <><path d="M17 6.1c-1.1-1.4-2.7-2-4.7-2-2.5 0-4.6 1.1-4.6 3.2 0 1.3.9 2.2 2.4 2.9m4 3.6c1.8.7 2.8 1.7 2.8 3.1 0 2-1.9 3.1-4.5 3.1-2.3 0-4-.8-5.2-2.3M4 12h16" /></>)

export const Squiggly = readerIcon('Squiggly', <><path d="M4.5 7V3.8h15V7M12 3.8v12.5M8.5 16.3h7M3.5 20c1.1-1.8 2.2-1.8 3.3 0s2.2 1.8 3.3 0 2.2-1.8 3.3 0 2.2 1.8 3.3 0 2.2-1.8 3.3 0" /></>)
export const Copy = readerIcon('Copy', <><rect x="8" y="7" width="12" height="14" rx="1.8" /><path d="M16 7V4.8A1.8 1.8 0 0 0 14.2 3H5.8A1.8 1.8 0 0 0 4 4.8v10.4A1.8 1.8 0 0 0 5.8 17H8" /></>)
export const Edit = readerIcon('Edit', <><path d="M15 9V7.5L10.5 3H5.5A1.5 1.5 0 0 0 4 4.5v15A1.5 1.5 0 0 0 5.5 21H10M10.5 3v4.5H15M7 11h4M7 14h2" /><path d="m12 16.7 6.8-6.8a1.2 1.2 0 0 1 1.7 0l.6.6a1.2 1.2 0 0 1 0 1.7L14.3 19l-3.3.9 1-3.2Zm5.6-5.6 2.3 2.3" /></>)
export const AddBookmark = readerIcon('AddBookmark', <><path d="M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v15.5L12 16l-6.5 4.5V5A1.5 1.5 0 0 1 7 3.5Z" /><path d="M12 7v6M9 10h6" /></>)
export const ReadAloud = readerIcon('ReadAloud', <><path d="M7 21v-4.1A6.2 6.2 0 0 1 3.5 11V9a5.5 5.5 0 0 1 11 0v1l2 3.2c.3.5 0 .9-.6.9h-1.4v2.1a1.8 1.8 0 0 1-1.8 1.8H11v3M13 15.6h1.5M11.2 9.8h.1M18 7.5a5 5 0 0 1 0 6m2-8.5a8.5 8.5 0 0 1 0 11" /></>)

export const Text = readerIcon('Text', <><path d="M3.5 7V4.2h17V7M12 4.2v15M8.2 19.2h7.6" /></>)

export const Note = readerIcon('Note', <><path d="M20 11.2c0-4.2-3.6-7.6-8-7.6s-8 3.4-8 7.6 3.6 7.6 8 7.6h7.7l-1.8-3.2a7.3 7.3 0 0 0 2.1-4.4Z" /><path d="M9 9h5.5M9 13h4.2" /></>)

export const Pen = readerIcon('Pen', <><path d="M12.8 3.9a1.8 1.8 0 0 1 2.5-.5l3 2.1a1.8 1.8 0 0 1 .4 2.5l-7.1 10.3-6.7 2.2.5-7 7.4-9.6Z" /><path d="m5.4 13.5 3.9 1.2 2.3 3.6M5.1 17.2l3 2.2" /></>)

export const Shapes = readerIcon('Shapes', <rect x="4.5" y="4.5" width="15" height="15" rx="1.5" />)

export const Measure = readerIcon('Measure', <><path d="M4 5.5h16M4 3.5v4M20 3.5v4" /><rect x="3.5" y="10.5" width="17" height="8" rx="1.3" /><path d="M7 10.5v3m3.5-3v4m3.5-4v3m3.5-3v4" /></>)

export const Attachment = readerIcon('Attachment', <path d="m9 12.5 6.2-6.2a2.2 2.2 0 0 1 3.1 3.1L9.7 18a3.6 3.6 0 0 1-5.1-5.1L14 3.5a5 5 0 0 1 7 7L11.6 20" />)

export const Sticker = readerIcon('Sticker', <><path d="M13.5 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7.5L13.5 20Z" /><path d="M13.5 20v-4.5a2 2 0 0 1 2-2H20M8 10h.01M15 10h.01m-7 3c1 1.3 3 1.6 4.5 1" /></>)

export const Stamp = readerIcon('Stamp', <><path d="M8.5 14v-2c0-1.8 1.3-2.1 1.3-4.6a2.2 2.2 0 0 1 4.4 0c0 2.5 1.3 2.8 1.3 4.6v2M5 14h14v4H5zM4 21h16" /></>)

export const Signature = readerIcon('Signature', <><path d="M3.5 15.5c3.4-1 9-6.1 9-9.9 0-1.5-1.5-1.7-2.6-.6-2.5 2.5-3.8 9.6-1.8 11.4 2 1.7 3.3-3.8 4.5-3.8.8 0-.4 3.8 1 3.8 1.1 0 2.1-2.1 2.8-2.1s.4 1.7 1.4 1.7c1.1 0 2.6-1.8 3-2.2M4 20h16" /></>)

export const Save = readerIcon('Save', <><path d="M5 3.5h12l3.5 3.6V19A1.5 1.5 0 0 1 19 20.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5Z" /><path d="M7 3.5V9h9V3.5M7.5 20.5V14h9v6.5M13.5 5.5V7" /></>)

export const Theme = readerIcon('Theme', <><path d="M9.5 14H19a1.5 1.5 0 0 1 1.5 1.5V19a1.5 1.5 0 0 1-1.5 1.5H7" /><path d="m9.5 8.5 4-4a1.5 1.5 0 0 1 2.1 0L19 7.9a1.5 1.5 0 0 1 0 2.1L8.7 20.3" /><path d="M5 3.5h3A1.5 1.5 0 0 1 9.5 5v12.5a3 3 0 0 1-6 0V5A1.5 1.5 0 0 1 5 3.5Z" /><circle cx="6.5" cy="17.5" r=".65" fill="currentColor" stroke="none" /></>)

export const Search = readerIcon('Search', <><circle cx="10.4" cy="10.4" r="7.2" /><path d="m15.6 15.6 5.2 5.2" /></>)

export const Pages = readerIcon('Pages', <><path d="M14 3.2H7.2a2.95 2.95 0 0 0-2.95 2.95v11.7a2.95 2.95 0 0 0 2.95 2.95h9.6a2.95 2.95 0 0 0 2.95-2.95V9.7c0-.8-.3-1.5-.9-2.1L15.9 4.1c-.5-.6-1.2-.9-1.9-.9Z" /><path d="M14 3.3v4.5a1.7 1.7 0 0 0 1.7 1.7h3.9" /></>)

export const Bookmark = readerIcon('Bookmark', <path d="M8 3.2h8a2.7 2.7 0 0 1 2.7 2.7v13.8c0 .9-.6 1.3-1.3.7l-4.6-4a1.2 1.2 0 0 0-1.6 0l-4.6 4c-.7.6-1.3.2-1.3-.7V5.9A2.7 2.7 0 0 1 8 3.2Z" />)

export const Comments = readerIcon('Comments', <><path d="M22 11.1C22 6.6 17.5 3 12 3S2 6.6 2 11.1s4.5 8.1 10 8.1c1.7 0 3.4-.4 4.8-1l4.3 2.9-1.2-5.1a7.3 7.3 0 0 0 2.1-4.9Z" /><path d="M7.7 8.6v5.2M12 8.6v5.2m4.3-5.2v5.2" /></>)

export const Outline = readerIcon('Outline', <><path d="M14 3.2H7.2a2.95 2.95 0 0 0-2.95 2.95v11.7a2.95 2.95 0 0 0 2.95 2.95h9.6a2.95 2.95 0 0 0 2.95-2.95V9.7c0-.8-.3-1.5-.9-2.1L15.9 4.1c-.5-.6-1.2-.9-1.9-.9Z" /><path d="M14 3.3v4.5a1.7 1.7 0 0 0 1.7 1.7h3.9" /><rect x="7.4" y="14.6" width="9.2" height="3.2" rx="1.1" /></>)

export const Grid = readerIcon('Grid', <><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.4" /><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.4" /><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.4" /><rect x="14" y="14" width="6.5" height="6.5" rx="1.4" /></>)

export const Tools = readerIcon('Tools', <><rect x="3.8" y="9" width="16.4" height="11.5" rx="3" /><path d="M9 9V7.8a1.5 1.5 0 0 1 1.5-1.5h3a1.5 1.5 0 0 1 1.5 1.5V9M9 14.5h6" /><circle cx="6.5" cy="5.4" r="1.7" fill="#f6cd55" stroke="none" /><circle cx="9.4" cy="2.8" r="1.4" fill="#f6cd55" stroke="none" /><circle cx="12.2" cy="4.8" r=".9" fill="#ac82ed" stroke="none" /><path d="m16 1.6.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" fill="#68baff" stroke="none" /></>)

export const Sparkles = readerIcon('Sparkles', <><path d="m9.5 5 2.4 5.6 5.6 2.4-5.6 2.4L9.5 21l-2.4-5.6L1.5 13l5.6-2.4L9.5 5Z" fill="#6279f3" stroke="none" /><path d="m18.5 1.5 1.3 3.2L23 6l-3.2 1.3-1.3 3.2-1.3-3.2L14 6l3.2-1.3 1.3-3.2Z" fill="#a26de2" stroke="none" /></>)

export const Close = readerIcon('Close', <path d="m6 6 12 12M18 6 6 18" />)
export const ChevronDown = readerIcon('ChevronDown', <path d="m6.5 9.5 5.5 5 5.5-5" />)
export const Undo = readerIcon('Undo', <><path d="M8 4 3.5 8.5 8 13" /><path d="M3.5 8.5H14a5.5 5.5 0 0 1 0 11h-3" /></>)
export const Redo = readerIcon('Redo', <><path d="m16 4 4.5 4.5L16 13" /><path d="M20.5 8.5H10a5.5 5.5 0 0 0 0 11h3" /></>)
export const Plus = readerIcon('Plus', <path d="M12 5v14M5 12h14" />)
export const More = readerIcon('More', <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>)

export const Open = readerIcon('Open', <><path d="M3.5 17V6.5A1.5 1.5 0 0 1 5 5h5l2 2h6.5A1.5 1.5 0 0 1 20 8.5V10" /><path d="M7 10h14l-2.8 9H3.5L7 10Z" /></>)

export const FitWidth = readerIcon('FitWidth', <><path d="M4 4v16M20 4v16M4 12h16m-4-4 4 4-4 4M8 8l-4 4 4 4" /></>)
export const Rotate = readerIcon('Rotate', <><path d="M19.5 8.5a8 8 0 1 0 .4 6M19.5 3.5v5h-5" /><path d="M8.5 8.5h6v7h-6z" /></>)
export const History = readerIcon('History', <><path d="M3.5 4.5v5h5" /><path d="M3.5 9.5a8 8 0 1 1 .1 6M12 7.5V12l3 2" /></>)
