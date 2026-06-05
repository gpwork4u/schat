// Schat brand mark — vectorized from the source artwork (public/logo.svg),
// rendered as an <img> so the ~27 KB trace isn't inlined on every render.
interface Props { size?: number; className?: string; }

export default function Logo({ size = 24, className }: Props) {
  return (
    <img
      src="/logo.svg"
      alt="Schat"
      className={className}
      style={{ height: size, width: 'auto', display: 'block' }}
    />
  );
}
