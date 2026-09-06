interface LogoProps {
  size?: number;
  /** Show the "OpenNAS" wordmark next to the glyph. */
  withWordmark?: boolean;
  className?: string;
}

/** The OpenNAS mark: a stacked "drive" glyph with an aurora gradient. */
export function Logo({ size = 40, withWordmark = false, className }: LogoProps) {
  return (
    <div className={`flex items-center gap-3 ${className ?? ""}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        <defs>
          <linearGradient id="opennas-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="55%" stopColor="#6366f1" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="44" height="44" rx="11" fill="url(#opennas-g)" />
        <rect x="9" y="13" width="30" height="8" rx="3" fill="white" fillOpacity="0.95" />
        <rect x="9" y="27" width="30" height="8" rx="3" fill="white" fillOpacity="0.7" />
        <circle cx="14.5" cy="17" r="1.6" fill="#1d4ed8" />
        <circle cx="14.5" cy="31" r="1.6" fill="#1d4ed8" />
      </svg>
      {withWordmark && (
        <span
          className="font-semibold tracking-tight text-white"
          style={{ fontSize: size * 0.5 }}
        >
          OpenNAS
        </span>
      )}
    </div>
  );
}
