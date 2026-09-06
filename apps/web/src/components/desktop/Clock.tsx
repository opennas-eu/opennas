import { useEffect, useState } from "react";

/** Live clock; compact (taskbar) or stacked (login) depending on context. */
export function Clock({ className, stacked = true }: { className?: string; stacked?: boolean }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

  if (!stacked) {
    return (
      <span className={className}>
        {time} - {date}
      </span>
    );
  }
  return (
    <div className={`leading-tight ${className ?? ""}`}>
      <div className="text-sm font-medium tabular-nums">{time}</div>
      <div className="text-[11px] opacity-70">{date}</div>
    </div>
  );
}
