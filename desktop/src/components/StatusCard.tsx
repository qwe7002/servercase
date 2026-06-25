interface GaugeProps {
  label: string;
  /** 0..100 */
  value: number | null;
  caption?: string;
}

function colorFor(pct: number): string {
  if (pct >= 90) return '#ff5d5d';
  if (pct >= 75) return '#ffb02e';
  return '#3fb950';
}

/** A circular percentage gauge drawn with a single SVG ring. */
export function Gauge({ label, value, caption }: GaugeProps) {
  const pct = value ?? 0;
  const r = 42;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <div className="card gauge">
      <svg viewBox="0 0 100 100" width="110" height="110">
        <circle cx="50" cy="50" r={r} className="gauge-track" />
        <circle
          cx="50"
          cy="50"
          r={r}
          className="gauge-fill"
          stroke={colorFor(pct)}
          strokeDasharray={`${dash} ${c}`}
          transform="rotate(-90 50 50)"
        />
        <text x="50" y="48" className="gauge-value">
          {value == null ? '–' : `${Math.round(pct)}%`}
        </text>
        <text x="50" y="64" className="gauge-label">
          {label}
        </text>
      </svg>
      {caption && <span className="gauge-caption">{caption}</span>}
    </div>
  );
}

interface BarProps {
  label: string;
  used: number;
  total: number;
  format: (kb: number) => string;
  /** 0..100 */
  pct: number;
}

/** A horizontal usage bar used for memory, swap and disks. */
export function UsageBar({ label, used, total, format, pct }: BarProps) {
  return (
    <div className="usage-bar">
      <div className="usage-bar-head">
        <span>{label}</span>
        <span className="muted">
          {format(used)} / {format(total)} · {Math.round(pct)}%
        </span>
      </div>
      <div className="track">
        <div
          className="fill"
          style={{ width: `${pct}%`, background: colorFor(pct) }}
        />
      </div>
    </div>
  );
}
