import { useId } from "react";

/** A filled area sparkline. `values` are plotted left→right, scaled to `max`. */
export function AreaChart({
  values,
  max,
  color,
  height = 120,
  className,
}: {
  values: number[];
  max: number;
  color: string;
  height?: number;
  className?: string;
}) {
  const gradId = useId();
  const width = 300;
  const n = Math.max(values.length, 2);
  const stepX = width / (n - 1);
  const safeMax = max <= 0 ? 1 : max;

  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = height - Math.min(1, Math.max(0, v / safeMax)) * height;
    return [x, y] as const;
  });

  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area =
    points.length > 0
      ? `${line} L${width},${height} L0,${height} Z`
      : "";

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
      style={{ width: "100%", height }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* horizontal gridlines at 25/50/75% */}
      {[0.25, 0.5, 0.75].map((g) => (
        <line
          key={g}
          x1="0"
          x2={width}
          y1={height * g}
          y2={height * g}
          stroke="currentColor"
          strokeOpacity="0.08"
          strokeWidth="1"
        />
      ))}
      {area && <path d={area} fill={`url(#${gradId})`} />}
      {line && <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />}
    </svg>
  );
}

/** Circular gauge for a single 0..100 percentage. */
export function RadialGauge({
  value,
  label,
  sublabel,
  color,
  size = 132,
}: {
  value: number;
  label: string;
  sublabel?: string;
  color: string;
  size?: number;
}) {
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, value));
  const dash = (pct / 100) * c;

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity="0.1" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c}`}
            style={{ transition: "stroke-dasharray 0.4s ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums text-ink">{Math.round(pct)}%</span>
          {sublabel && <span className="text-[11px] text-ink-faint">{sublabel}</span>}
        </div>
      </div>
      <span className="mt-2 text-sm font-medium text-ink-soft">{label}</span>
    </div>
  );
}
