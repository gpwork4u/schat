// Schat (Slack-for-Google-Chat) brand mark: a speech bubble holding a
// Slack-style colored hashtag. `size` controls the square icon; the speech
// bubble uses currentColor so it adapts to light/dark surfaces.
interface Props { size?: number; className?: string; }

export default function Logo({ size = 24, className }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none"
      xmlns="http://www.w3.org/2000/svg" className={className} aria-label="Schat">
      <path
        d="M11 7h26a6 6 0 0 1 6 6v13a6 6 0 0 1-6 6H20l-8 7v-7h-1a6 6 0 0 1-6-6V13a6 6 0 0 1 6-6z"
        fill="currentColor" fillOpacity="0.06" stroke="currentColor" strokeOpacity="0.15" strokeWidth="1.2" />
      <rect x="11" y="15.3" width="22" height="5" rx="2.5" fill="#36C5F0" />
      <rect x="11" y="23.5" width="22" height="5" rx="2.5" fill="#E01E5A" />
      <rect x="15.2" y="11.2" width="5" height="21" rx="2.5" fill="#ECB22E" />
      <rect x="23.8" y="11.2" width="5" height="21" rx="2.5" fill="#2EB67D" />
      <rect x="20" y="16.6" width="4" height="4.4" rx="1.4" fill="#fff" fillOpacity="0.9" />
    </svg>
  );
}
