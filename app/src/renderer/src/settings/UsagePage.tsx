// Settings › Usage (#21): tokens and reported cost for the last 7, 30 or 90 days, per day and per bot. Cost shows
// only where the provider reports it (Claude); every provider reports tokens.
import { type CSSProperties, useCallback, useEffect, useId, useRef, useState } from "react";
import type { UsageReport } from "../../../../../server/src/client/gateway-client.ts";
import type { PublicBot } from "../../../../../server/src/types.ts";
import { call } from "../gateway.ts";
import { Avatar } from "../shell/Avatar.tsx";
import { Section } from "./controls.tsx";
import { barShares, dayLabel, formatCost, formatTokens } from "./usage-format.ts";

const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];

/** Inline styles carry only computed values, as custom properties the stylesheet reads. */
const vars = (values: Record<`--${string}`, string>) => values as CSSProperties;

export function UsagePage({ bots }: { bots: readonly PublicBot[] }) {
  const [period, setPeriod] = useState<Period>(7);
  const [report, setReport] = useState<UsageReport>();
  const [error, setError] = useState<string>();

  // Only the latest request may land: a slow answer for an earlier period mustn't replace the current one.
  const latest = useRef(0);
  const load = useCallback(async (days: Period) => {
    const n = ++latest.current;
    setError(undefined);
    setReport((r) => (r?.days.length === days ? r : undefined));
    try {
      const got = await call("usage", days);
      if (n === latest.current) setReport(got);
    } catch (err) {
      if (n === latest.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load(period);
  }, [load, period]);

  const total = report?.total;
  const shares = report ? barShares(report.days) : [];

  return (
    <>
      <PeriodSwitch value={period} onChange={setPeriod} />
      {error && (
        <p className="settings-note" data-tone="error" role="alert">
          Couldn't load usage: {error}{" "}
          <button type="button" className="button secondary small" onClick={() => void load(period)}>
            Try again
          </button>
        </p>
      )}
      {report && total && (
        <>
          <Section title="Total">
            <div className="usage-total">
              <div>
                <span className="usage-big">{formatTokens(total.inputTokens + total.outputTokens)}</span>{" "}
                <span className="usage-unit">tokens</span>
              </div>
              <span className="settings-description">
                {formatTokens(total.inputTokens)} in · {formatTokens(total.outputTokens)} out · {total.runs}{" "}
                {total.runs === 1 ? "reply" : "replies"}
                {report.costReported && ` · ${formatCost(total.costUsd)}`}
              </span>
            </div>
          </Section>
          <Section title="By day">
            {total.runs === 0 ? (
              <p className="usage-empty">No usage yet in this period.</p>
            ) : (
              <div className="usage-chart" data-period={period}>
                {report.days.map((d, i) => {
                  const label = `${dayLabel(d.date)}: ${formatTokens(d.inputTokens + d.outputTokens)} tokens`;
                  return (
                    <div key={d.date} className="usage-bar" title={label} role="img" aria-label={label}>
                      <span className="usage-bar-fill" style={vars({ "--bar-share": `${shares[i] ?? 0}%` })} />
                    </div>
                  );
                })}
              </div>
            )}
            {total.runs > 0 && (
              <div className="usage-axis" aria-hidden="true">
                <span>{dayLabel(report.from)}</span>
                <span>{dayLabel(report.to)}</span>
              </div>
            )}
          </Section>
          <Section title="By bot">
            {report.bots.length === 0 ? (
              <p className="usage-empty">No usage yet in this period.</p>
            ) : (
              report.bots.map((b) => {
                const bot = bots.find((x) => x.id === b.botId);
                return (
                  <div key={b.botId} className="settings-row">
                    <div className="usage-bot">
                      {bot && <Avatar avatar={bot.avatar} size="small" />}
                      <span className="settings-label">{bot?.name ?? b.botId}</span>
                    </div>
                    <span className="settings-value">
                      {formatTokens(b.inputTokens + b.outputTokens)} tokens
                      {report.costReported && b.costUsd > 0 && ` · ${formatCost(b.costUsd)}`}
                    </span>
                  </div>
                );
              })
            )}
          </Section>
          <p className="settings-note">
            Cost is shown where the provider reports it (Claude). Other providers report tokens only.
          </p>
        </>
      )}
    </>
  );
}

/** 7 / 30 / 90 days: native radio buttons dressed as a segmented control, so arrow keys move the choice. */
function PeriodSwitch({ value, onChange }: { value: Period; onChange(p: Period): void }) {
  const name = useId();
  return (
    <fieldset className="usage-periods">
      <legend className="visually-hidden">Period</legend>
      {PERIODS.map((p) => (
        <label key={p} className="usage-period" data-checked={p === value || undefined}>
          <input
            type="radio"
            className="visually-hidden"
            name={name}
            checked={p === value}
            onChange={() => onChange(p)}
          />
          {p} days
        </label>
      ))}
    </fieldset>
  );
}
