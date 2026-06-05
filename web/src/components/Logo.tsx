import { useId } from 'react';

// Schat brand mark: a gradient "infinity knot" with two antennae splaying out
// from the top and a blue/pink woven crossing at the centre. Transparent vector.
interface Props { size?: number; className?: string; }

export default function Logo({ size = 24, className }: Props) {
  const gid = `schat-grad-${useId().replace(/:/g, '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none"
      xmlns="http://www.w3.org/2000/svg" className={className} aria-label="Schat">
      <defs>
        <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1="15" y1="22" x2="49" y2="46">
          <stop offset="0" stopColor="#8B5CF6" />
          <stop offset="0.38" stopColor="#4F9CF5" />
          <stop offset="0.64" stopColor="#2DD4BF" />
          <stop offset="1" stopColor="#F2617E" />
        </linearGradient>
      </defs>
      {/* infinity knot + splayed antennae */}
      <g stroke={`url(#${gid})`} strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M32 40 C 27 31, 14 31, 14 40 C 14 49, 27 49, 32 40 C 37 31, 50 31, 50 40 C 50 49, 37 49, 32 40 Z" />
        <path d="M21 31 C 19.5 25, 18.5 21, 16.5 15.5" />
        <path d="M43 31 C 44.5 25, 45.5 21, 47.5 15.5" />
      </g>
      {/* central woven crossing */}
      <g strokeWidth="5" strokeLinecap="round">
        <path d="M27 45.5 L 34.5 34.5" stroke="#3B9EF5" />
        <path d="M30.5 34.5 L 38 45.5" stroke="#F2617E" />
      </g>
    </svg>
  );
}
