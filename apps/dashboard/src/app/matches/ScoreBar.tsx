export function ScoreBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="score-row">
      <span>{label}</span>
      <span className="score-bar-track">
        <span className="score-bar-fill" style={{ width: `${pct}%` }} />
      </span>
      <span>{pct}%</span>
    </div>
  );
}
