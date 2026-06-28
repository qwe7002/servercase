/**
 * A tiny dependency-free multi-series line chart (SVG). Values are percentages
 * (0–100). Nulls break the line. Used for probe history.
 */
interface Series {
  label: string;
  color: string;
  values: (number | null)[];
}

export function LineChart({
  series,
  height = 140,
  max = 100,
}: {
  series: Series[];
  height?: number;
  max?: number;
}) {
  const width = 600; // viewBox units; scales responsively
  const padX = 4;
  const padY = 8;
  const n = Math.max(...series.map((s) => s.values.length), 0);
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const x = (i: number) => padX + (n <= 1 ? 0 : (i / (n - 1)) * innerW);
  const y = (v: number) => padY + innerH - (Math.min(max, Math.max(0, v)) / max) * innerH;

  const pathFor = (values: (number | null)[]) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };

  const gridLines = [0, 25, 50, 75, 100].filter((g) => g <= max);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-36 w-full"
      role="img"
    >
      {gridLines.map((g) => (
        <line
          key={g}
          x1={padX}
          x2={width - padX}
          y1={y(g)}
          y2={y(g)}
          stroke="var(--border)"
          strokeWidth={0.5}
        />
      ))}
      {series.map((s) =>
        s.values.some((v) => v != null) ? (
          <path
            key={s.label}
            d={pathFor(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth={1.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null,
      )}
    </svg>
  );
}
