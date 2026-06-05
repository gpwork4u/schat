import { useId } from 'react';

// Schat brand mark: a gradient "infinity knot" (two interlocked loops) with two
// small antennae rising from the top — recreated as a transparent vector.
interface Props { size?: number; className?: string; }

export default function Logo({ size = 24, className }: Props) {
  const gid = `schat-grad-${useId().replace(/:/g, '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none"
      xmlns="http://www.w3.org/2000/svg" className={className} aria-label="Schat">
      <defs>
        <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1="12" y1="46" x2="52" y2="18">
          <stop offset="0" stopColor="#8B5CF6" />
          <stop offset="0.4" stopColor="#3B9EF5" />
          <stop offset="0.7" stopColor="#2DD4BF" />
          <stop offset="1" stopColor="#F26D8B" />
        </linearGradient>
      </defs>
      <g stroke={`url(#${gid})`} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" fill="none">
        {/* figure-eight / infinity knot */}
        <path d="M32 40 C 27 31, 14 31, 14 40 C 14 49, 27 49, 32 40 C 37 31, 50 31, 50 40 C 50 49, 37 49, 32 40 Z" />
        {/* antennae */}
        <path d="M22 33 L 18.5 16" />
        <path d="M42 33 L 45.5 16" />
      </g>
    </svg>
  );
}
