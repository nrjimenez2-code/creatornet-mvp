'use client';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import BackButton from '@/components/BackButton';
import { analyticsSections, formatMetric, sectionLabels, type AnalyticsDetail, type AnalyticsWindow } from '@/lib/analytics-dashboard';
import styles from './analytics.module.css';

const dayLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
export default function AnalyticsDashboard({ detail, window }: { detail: AnalyticsDetail; window: AnalyticsWindow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const navigate = (section: string, days: string) => startTransition(() => router.push(`/dashboard/analytics?section=${section}&days=${days}`, { scroll: false }));
  const total = detail.points.reduce((sum, point) => sum + point.value, 0);
  const peak = detail.points.reduce<(typeof detail.points)[number] | null>((best, point) => !best || point.value > best.value ? point : best, null);
  const format = (value: number) => formatMetric(value, detail.unit);
  return <main className={styles.page}>
    <div className={styles.backCorner}><BackButton hrefOverride="/dashboard" className={styles.backButton} /></div>
    <div className={styles.content}>
      <header className={styles.header}>
        <div><h1>Analytics</h1><p>A closer look at your performance.</p></div>
      </header>
      <div className={styles.panel}>
        <div className={styles.toolbar}>
          <nav aria-label="Analytics sections"><label htmlFor="analytics-section">Metric</label>
            <select id="analytics-section" aria-label="Analytics section" value={detail.section} disabled={pending} onChange={e => navigate(e.target.value, String(window.days))}>{analyticsSections.map(section => <option key={section} value={section}>{sectionLabels[section]}</option>)}</select>
          </nav>
          <div className={styles.dateControls}>
            <label className={styles.srOnly} htmlFor="analytics-days">Date range</label>
            <select id="analytics-days" value={String(window.days)} disabled={pending} onChange={e => navigate(detail.section, e.target.value)}><option value="7">Last 7 days</option><option value="14">Last 14 days</option><option value="30">Last 30 days</option></select>
            <p>{dayLabel(window.start)} – {dayLabel(window.end)}, {window.end.slice(0, 4)} · UTC</p>
          </div>
        </div>
        <section className={styles.detail} aria-label={`${detail.title} analytics`} aria-busy={pending}>
          {pending && <p role="status">Loading analytics…</p>}
          <h2 className={styles.srOnly}>{detail.title}</h2>
          <dl className={styles.summary}>
            <div className={styles.primary}><dt>{detail.metric}</dt><dd>{detail.unavailable ? '—' : format(total)}</dd></div>
            <div><dt>Daily average</dt><dd>{detail.unavailable ? '—' : format(total / window.days)}</dd></div>
            <div><dt>Peak day</dt><dd>{!detail.unavailable && total && peak ? dayLabel(peak.date) : '—'}</dd></div>
          </dl>
          {detail.unavailable ? <div className={styles.error} role="alert"><h3>Analytics unavailable</h3><p>We couldn’t load this section. Try again or choose a shorter date range.</p><button onClick={() => startTransition(() => router.refresh())} disabled={pending}>Try again</button></div> : <>
            <div className={styles.chartHeader}><h3>{detail.metric} over time</h3><span>Daily</span></div>
            <div className={styles.chart} role="img" aria-label={`${detail.metric}: ${format(total)} over ${window.days} days. Daily values are available below.`}>
              <ResponsiveContainer width="100%" height="100%"><AreaChart data={detail.points} margin={{ top: 16, right: 12, bottom: 12, left: 0 }}>
                <defs><linearGradient id="analytics-purple" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#6044df" stopOpacity={0.28} /><stop offset="100%" stopColor="#6044df" stopOpacity={0.02} /></linearGradient></defs>
                <CartesianGrid stroke="#29292f" strokeDasharray="3 5" vertical={false} />
                <XAxis dataKey="date" tickFormatter={dayLabel} minTickGap={28} tick={{ fill: '#a4a4ae', fontSize: 12 }} stroke="#383840" tickMargin={12} />
                <YAxis width={64} allowDecimals={detail.unit === 'currency'} tickFormatter={value => detail.unit === 'currency' ? `$${Number(value) / 100}` : String(value)} tick={{ fill: '#a4a4ae', fontSize: 12 }} axisLine={false} tickLine={false} domain={[0, total === 0 ? 1 : 'auto']} />
                <Tooltip labelFormatter={label => dayLabel(String(label))} formatter={value => [format(Number(value)), detail.metric]} contentStyle={{ background: '#101013', border: '1px solid #3a3a43', borderRadius: 10, color: '#f7f7f8' }} />
                <Area type="linear" dataKey="value" stroke="#7659ef" strokeWidth={2} fill="url(#analytics-purple)" isAnimationActive={false} activeDot={{ r: 4 }} />
              </AreaChart></ResponsiveContainer>
            </div>
            {total === 0 && <p className={styles.empty}>No {detail.metric.toLowerCase()} recorded for this period.</p>}
            {detail.stats.length > 0 && <dl className={styles.stats}>{detail.stats.map(stat => <div key={stat.label}><dt>{stat.label}</dt><dd>{stat.value}</dd></div>)}</dl>}
            <details className={styles.tableDetails}><summary>View daily values</summary><table><caption className={styles.srOnly}>{detail.metric} by day, UTC</caption><thead><tr><th scope="col">Date</th><th scope="col">{detail.metric}</th></tr></thead><tbody>{detail.points.map(point => <tr key={point.date}><th scope="row">{dayLabel(point.date)}</th><td>{format(point.value)}</td></tr>)}</tbody></table></details>
          </>}
          <p className={styles.definition}>{detail.description}</p>
        </section>
      </div>
    </div>
  </main>;
}
